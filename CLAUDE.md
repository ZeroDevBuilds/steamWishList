# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local Node/Express server that lists the games on the user's Steam wishlist currently on sale,
sorted by lowest price, flagging whether the current price is the lowest that game has ever been
(via [IsThereAnyDeal](https://isthereanydeal.com)). Single-user, runs locally, backed by SQLite.

## Commands

- `npm run dev` — local dev server on http://127.0.0.1:3000 (builds the client once first, then
  `tsx watch`s the server — auto-restarts on server-side changes).
- `npm run dev:client` — run in a second terminal when actively editing `public/app.ts`; rebuilds
  `public/app.js` on save via esbuild watch. The main `dev` server does not watch client files.
- `npm run build` — compiles server (`tsc`) to `dist/` and bundles the client (`esbuild`).
- `npm start` — runs the compiled build (`node dist/server.js`). Production entrypoint.

No test suite and no lint script currently exist in this repo.

This dev environment (WSL Ubuntu) has no browser automation tooling installed — no
`chromium-cli`, no Playwright/Puppeteer. Don't try to install or invoke one to verify UI changes.
Verify server/API changes with `curl` against the running dev server, and verify frontend changes
by reading `public/app.ts`/`index.html`/`styles.css` and reasoning through the DOM output; ask the
user to eyeball it in an actual browser when a visual check is truly needed.

Before running `npm run dev` (or anything else that binds port 3000), check for and kill any
process already listening there — a stale server from a previous session silently keeps serving
old code otherwise: `lsof -ti:3000 -sTCP:LISTEN | xargs -r kill`.

If you start the dev server yourself for testing/debugging, stop it again
(`lsof -ti:3000 -sTCP:LISTEN | xargs -r kill`) once you're done — don't leave it running at the
end of a session. Tell the user to run `npm run dev` themselves when they want it up for
continued use.

### Setup

Requires a `.env` (copy from `.env.example`): `STEAM_ID64` (wishlist must be public),
`STEAM_API_KEY`, `ITAD_API_KEY`. See `.env.example` for all cache-TTL and debug env vars.

### Verifying the Steam wishlist response shape

Valve's `IWishlistService/GetWishlist/v1` response shape has changed before. Before trusting
`/api/wishlist`, hit `GET /api/debug/wishlist-raw` and confirm the JSON matches what
`src/services/steamWishlist.ts` expects (`response.items[].appid` etc.); adjust parsing there if
not. This debug route is intentionally temporary.

## Architecture

**Request flow:** `src/server.ts` mounts `wishlistRouter` (`src/routes/wishlist.ts`) at `/api` and
serves the static `public/` bundle otherwise. The route handler is a thin wrapper around
`getWishlistData()` in `src/services/aggregate.ts`, which is the core of the app.

**Aggregation pipeline** (`src/services/aggregate.ts`):
1. Fetch the raw wishlist (list of appids) from Steam — `services/steamWishlist.ts`.
2. Fetch every wishlist item's Steam store price (`fetchSteamPrices`, `services/steamStore.ts`) —
   this determines sale status, so it always runs against the *full* wishlist regardless of the
   game limit. Appids already in the per-appid price cache are served from there; the misses are
   fetched in **batches** of `STEAM_PRICE_BATCH_SIZE` (150) appids per request, so a 315-game
   wishlist is ~2 upstream calls (a few seconds), not 315 throttled ones (5+ minutes).
3. Filter to games currently on sale (`discountPercent > 0`) and *then* apply the game limit
   (`debugGameLimit`) to that filtered set — the limit caps how many on-sale games get the
   expensive ITAD enrichment below, not how many raw wishlist items get price-checked. Games
   not on sale are dropped here and never appear in the response.
4. For the surviving (on-sale, limited) items not already in the 24h per-game cache, batch-fetch
   name + header artwork + release date (`fetchSteamStoreItems`, `STEAM_ITEM_BATCH_SIZE` = 100 per
   request). This is a *separate* endpoint from the price call by necessity, see the note below.
   Failure here is non-fatal — the game renders with a placeholder name, the guessed header URL
   and no release date.
5. For each of those same items, concurrently
   look up its ITAD game UUID + public page URL from the Steam appid (`services/itad.ts`
   `lookupItadId`, `games/lookup/v1`).
6. **Sync** each resolved game's Steam price history into the local store (`services/priceHistory.ts`
   → `fetchItadHistory`, `games/history/v2`). This is a sync, not a fetch: most games are already
   current and cost *zero* upstream calls. See "Local price history" below.
   Note: `since` must be an ISO timestamp with no milliseconds component or ITAD 400s it — and
   omitting `since` entirely does *not* return full history (ITAD defaults to a short recent
   window), so a backfill passes a deliberately ancient timestamp instead.
   One batched ITAD endpoint exists but is deliberately *not* used:
   `POST /lookup/id/shop/61/v1` maps many Steam appids to ITAD ids in one call, but returns only
   ids — no `slug`, and `itadUrl` is built from the slug, since `games/info/v2` reports the slug
   form as the game's canonical URL.
7. Merge into `WishlistGame` objects (`src/types/wishlistItem.ts`), deriving `historyLowPrice`/
   `isLowestEver` and `recentSales` from the **local** history rows, sort by price asc then
   discount % desc, and return `WishlistResponse`.

**Steam-only, everywhere.** Every ITAD call is scoped to `shops=61` (Steam). The app compares
Steam prices to Steam prices and nothing else — there is deliberately no "cheaper elsewhere"
feature, and `games/prices/v3` (which existed only to serve it) is no longer called at all.
Note the bare `shops=61` query form; `shops[]=61` makes ITAD return a 500.

**Local price history (`src/cache/historyStore.ts`, tables `price_history` / `history_sync`)** —
this is *not* a cache and has no TTL. A price change that happened on a date is a fact, so rows
are only ever appended. Three consequences worth internalising before changing anything here:
- **Store the log, never the low.** The lowest price *within a window* is derived per request by
  `queryWindowLow`, because a rolling window slides: an old low ages out and the correct answer
  moves back **up**. A stored-low-plus-min-merge can only ever move down, so it would pin
  `isLowestEver` to a price that left the window and silently report false negatives forever.
- **The window low excludes the sale currently in progress** (`priorSaleCeiling`). Since the
  running sale is itself a row in the history, including it makes the low equal the current
  price, and `isLowestEver` true for any game merely sitting at its usual discount. Excluding
  it makes the flag mean the useful thing: *does this sale match or beat every previous one?*
  Note the flag is `<=`, so a game that discounts to the same price every sale still reads as
  true — that's accurate, not a bug. Tighten to `<` in `aggregate.ts` if you ever want the
  filter to surface only sales that strictly beat their predecessors.
- **The re-sync gate is the watermark (`synced_through`), never `last_change_at`.** The latter is
  a property of how often the game goes on sale, not of our freshness — a dormant game's
  last-change date is old permanently and no amount of fetching moves it, so gating on it would
  re-poll exactly the games with nothing to fetch, on every refresh. `last_change_at` is stored
  anyway because it's a good signal for how *often* to poll (adaptive cadence), if ever wanted.
- **Backfill wide once** (`ITAD_HISTORY_BACKFILL_YEARS`, effectively all-time). It's one call
  either way — only the payload differs — so scoping the first backfill to the currently
  requested `years` would just guarantee another round trip per game the first time the user
  widens the window. Because the backfill is wide, changing `years` costs **zero** ITAD calls;
  it's a pure SQL re-query (verified: 1y/3y/all-time all served in ~45ms with 0 upstream calls).

`recentSales` (which drives the UI's sale-trend chart) is folded from the same rows by `querySaleEpisodes`: a
`cut > 0` entry opens a discount episode and the next `cut === 0` closes it, with consecutive
`cut > 0` rows merged into one episode (Steam re-cuts mid-sale, which would otherwise split one
sale into a run of adjacent one-day "sales"). An episode still open at the end of the log is a
sale running right now (`endDate: null`).

`pricePoints` (`queryPricePoints`) is the raw timeline the chart draws, bounded to the span of
`recentSales` rather than to `historyYears` — a decade of points for `years=0` would bloat every
response for a chart that only draws the recent stretch. It's sent as points, not a rendered
path, so the client can re-window the chart without a refetch.

**Two independent layers of caching**, both against the same SQLite file
(`data/cache.sqlite`, via `src/cache/db.ts` / `cacheStore.ts`):
- Per-endpoint caches (wishlist list, Steam price, Steam store metadata, ITAD lookup) — each with
  its own TTL from `config.cacheTtl`.
  The Steam price/metadata caches are read and written **per appid** (`steam:price:v2:{appid}:{cc}`,
  `steam:item:v2:{appid}`) even though the fetches are batched, so a partially-warm wishlist only
  requests what it's actually missing. The item key carries a version for the same reason the
  game key does — v2 added `releaseDate`, and v1 blobs would have rendered undated until their TTL
  ran out.
- A **per-game 24h cache** (`CACHE_TTL_GAME_SEC`) of the fully-enriched `WishlistGame`, keyed by
  `wishlist:game:v6:{countryCode}:{historyYears}y:{appid}`. This is the layer that actually protects
  against hitting Steam/ITAD rate limits — only games whose entry has expired (for the requested
  `historyYears`) trigger new upstream calls, independent of anything else. **Bump the version when
  `WishlistGame`'s shape *or its semantics* change**, or stale blobs render missing fields as empty
  (see the running changelog above `gameCacheKey` in `aggregate.ts`).
- `getOrFetch()` is the shared read-through-cache helper used everywhere; `forceRefresh` bypasses
  the *read* but always writes the fresh result back.

**Refresh semantics** (query params on `GET /api/wishlist`), all handled in `wishlist.ts` /
`aggregate.ts` — don't conflate these:
- `refresh=1` — bypasses the wishlist-list cache only; per-game data still comes from the 24h
  cache if fresh.
- `force=1` — implies `refresh=1` **and** bypasses the 24h per-game cache for every game (not
  just stale ones), forcing a full re-fetch of price data for the whole wishlist. For price
  *history* it forces a **delta** sync (`since = watermark`), deliberately not a re-backfill:
  re-reading years of immutable rows costs wall time and buys nothing.
- `debug=0` / `limit=N` — only meaningful when `DEBUG_GAME_LIMIT` is set server-side
  (`debugCapable`); lets the client narrow or lift the server-configured cap on how many on-sale
  wishlist games get enriched, for fast local iteration on a large wishlist.
- `years=N` — scopes the price-history-low lookback used for `historyLowPrice`/`isLowestEver`:
  `1` = past year (default), `2` = past two years, etc.; `0` = all-time. Always available
  (not gated behind `debugCapable`), though the UI control for it lives in the debug panel.
  Echoed back as `historyYears` on the response so the client can reflect the active window.
  Since the backfill is wide, changing this is a local re-query — no upstream calls.
  Note it scopes the *low* only: `recentSales` is deliberately not windowed, because "the last
  3 sales" should mean the last 3 rather than silently rendering short inside a narrow window.

**Rate limiting:** Steam's storefront API and ITAD's API are throttled independently, and the
two use *different* limiters from `src/utils/concurrency.ts` because their limits differ in kind:
- **Steam** — `createRateLimiter()`, a fixed minimum interval between calls, since Steam
  publishes no quota and the risk is an unspaced burst tripping Akamai (see below).
- **ITAD** — `createWindowRateLimiter()`, a sliding-window budget, because ITAD documents an
  explicit quota (1000 requests / 5 min per key for a verified account) and asks clients not to
  sit at the ceiling. Defaults are `ITAD_MAX_REQUESTS_PER_WINDOW=800` per `ITAD_RATE_WINDOW_SEC=300`,
  plus a small `ITAD_THROTTLE_MS=50` burst damper. **Don't** swap this back for fixed spacing:
  a whole refresh is a few hundred calls and then nothing for an hour, so pinning throughput at
  the sustained average (the old 300ms spacing) wasted the entire budget and made ITAD the
  slowest part of a refresh once Steam's calls were batched. Per-game ITAD calls run at
  `ITAD_CONCURRENCY` (8) in `aggregate.ts`; the limiter, not the concurrency, is the real ceiling.

`src/utils/http.ts`'s `fetchJson` adds retry-with-backoff on top of both (honouring `Retry-After`,
which ITAD sends with its 429s), but only for 429/5xx — a 403 is treated as non-retryable and
fails immediately. Steam's storefront endpoint in particular can 403 an entire IP after an unspaced
burst (Akamai bot protection); step 2 of the aggregation pipeline sweeps the *full* wishlist
every time its cache goes cold, so keeping that sweep to a handful of requests is what keeps it
safe (it has tripped in practice on a ~300-game wishlist, back when the sweep was one request
per game). The spacing between Steam calls is tunable via `STEAM_PRICE_THROTTLE_MS`
(`config.steamPriceThrottleMs`, default 1000ms, shared by the price and store-metadata calls) —
raise it if 429s persist at the default.

**Batching Steam requests — the constraint to know:** `appdetails` only honours a
comma-separated `appids=` list when `filters` is restricted to `price_overview`. Asking for
`basic` (name, `header_image`) as well makes a multi-appid request return `null`, so the two
can't be combined. Hence the split in `services/steamStore.ts`: `fetchSteamPrices` batches
prices through `appdetails` (currency included), and `fetchSteamStoreItems` batches name +
header artwork + release date through the Web API's `IStoreBrowseService/GetItems/v1` (no API key
needed; the header URL is assembled from `assets.asset_url_format` + `assets.header`, which
reproduces appdetails' `header_image` exactly, and the release date comes from
`release.steam_release_date`, unix seconds, which Steam sends as `0` rather than omitting when it
has no date). GetItems' extra fields are opt-in `data_request` flags that widen the *same* call,
so more per-game metadata costs no extra requests. **Do not** go back to one `appdetails` call
per game.

`fetchSteamPrices` lets transient failures propagate rather than swallowing them, and
distinguishes them from real answers: an appid mapped to `null` is a definite "Steam has no
price here" (delisted/free/region-locked), an appid *absent* from the returned map got no
answer. A `null`/non-object response body throws rather than marking the whole batch priceless.
`getWishlistData` excludes any failed appid from the response for this request (it's simply
missing from the on-sale count, not shown as "unavailable") and negative-caches it for a short
TTL (`CACHE_TTL_STEAM_PRICE_FAILURE_SEC`, default 120s) — long enough that an immediate page
reload doesn't re-hammer Steam for the same game, short enough that the failure isn't mistaken
for a real "no price data" result anywhere near the full `steamPriceSec` TTL. **Do not** revert
to caching a caught fetch error under the normal-TTL price cache key — that turned a
several-second Akamai block into an hour of every game silently looking not-on-sale (see git
history around the sale-filter/negative-cache fixes for the incident this guards against).

**Frontend:** `public/app.ts` (compiled to `app.js` via esbuild, no framework) fetches
`/api/wishlist` and renders the game list plus the debug controls when `debugCapable` is true.
Default sort is price ascending; a View icon-button toggle (grid/list icons, rightmost in the
controls bar) switches between card and compact list layouts (`.list-view` class on
`#game-list`, styled in `styles.css`). There is no client-side "on sale
only" filter — the server only ever returns on-sale games, per the pipeline above.
`public/index.html` / `styles.css` are static, not templated server-side.

The controls bar (`.controls`) stacks three rows (`.controls-row`): sort/search/refresh/view-toggle,
then the ITAD/potential-purchase filter checkboxes plus the sale-trend controls, then the debug
panel. The **sale-trend** controls (a `Sale trend` checkbox and a `Sales shown` count, persisted
to `localStorage` under `wishlist:saleTrend`) are pure display state: the server always sends up
to `SALE_EPISODE_LIMIT` episodes and the client slices, so toggling either **re-renders without
refetching**. Keep it that way — making the count a query param would fragment the per-game cache
by every value the user ever picks, exactly as `historyYears` already does.

The trend renders as a hand-built inline **SVG step chart** (`renderSaleTrend` in `app.ts`,
`.trend-*` rules in `styles.css`) — no chart library, nothing fetched from a CDN. Two things to
preserve if you touch it:
- **It must stay a *step* line.** The price holds flat and then jumps; interpolating between
  points would draw prices that never existed and would hide the return to full price between
  sales, which is the entire shape worth seeing.
- **The right edge is Steam's live price, not ITAD's last log entry**, so the chart agrees with
  the price printed on the card even when ITAD's history lags a day or two behind a new sale.

It's one series, so per the dataviz guidance there's no legend (the label above names it), the
line wears `--accent` while all text stays in `--muted`, the reference hairline marks the prior
low, and only the two price extremes are labelled. Hover targets are one `<rect>` per flat
stretch with a native `<title>` — enough for a chart this small, and it scales to 30 cards
without a tooltip engine. Refresh is an icon-only
button (`.icon-btn`); Force Refresh stays a labeled text button since it's the higher-stakes action.
Debug control values (debug mode, game limit, history years) are persisted to `localStorage`
(`wishlist:debugControls`) only when the **Save** button in the debug row is clicked — not on every
change — and are restored from there (instead of from the server's `debugGameLimit`/`historyYears`
defaults) on subsequent loads, including real browser reloads, via `loadSavedDebugControls()` /
`pendingDebugReload` in `app.ts`. Dates (`formatDate`) render as `d MMM yyyy` (e.g. `13 Aug 2026`),
not a numeric format. The release date is the exception that reads its parts with **UTC** getters
(`formatReleaseDate`): Steam's release timestamps are UTC midnights, so local getters would slide
a launch day backwards for anyone west of UTC. It sits right-aligned opposite the title inside
`.title-row`, which is also the flex child `.body` lays out in list view — style the row, not the
`h2`, when changing that layout.
