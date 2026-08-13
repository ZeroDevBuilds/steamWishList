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
2. Fetch every wishlist item's Steam store price (`services/steamStore.ts`, concurrently via
   `mapWithConcurrency`, limit 5) — this determines sale status, so it always runs against the
   *full* wishlist regardless of the game limit (results are cached per-endpoint, so this is
   cheap after the first run within `steamPriceSec`).
3. Filter to games currently on sale (`discountPercent > 0`) and *then* apply the game limit
   (`debugGameLimit`) to that filtered set — the limit caps how many on-sale games get the
   expensive ITAD enrichment below, not how many raw wishlist items get price-checked. Games
   not on sale are dropped here and never appear in the response.
4. For each surviving (on-sale, limited) item not already in the 24h per-game cache, concurrently
   look up its ITAD game UUID + public page URL from the Steam appid (`services/itad.ts`
   `lookupItadId`, `games/lookup/v1`).
5. Batch-fetch current deals from ITAD for all resolved ITAD ids in one call (`fetchItadPrices`).
   The price-history-low fetch depends on the `historyYears` window (see below): a scoped window
   (years >= 1) only accepts one game id per call, so it's fetched per-game via `fetchItadHistoryLow`
   (`games/history/v2`, scoped with `since`); all-time (years === 0) has a dedicated batch endpoint,
   `fetchItadHistoryLowAllTime` (`games/historylow/v1`), fetched once for every resolved id like
   `fetchItadPrices` above. Note: `since` must be an ISO timestamp with no milliseconds component
   or ITAD 400s it — omitting `since` entirely does *not* return full history (ITAD defaults to a
   short recent window), so it can't be used to approximate all-time.
6. Merge into `WishlistGame` objects (`src/types/wishlistItem.ts`), compute `isLowestEver` and
   `bestDealElsewhere`, sort by price asc then discount % desc, and return `WishlistResponse`.

**Two independent layers of caching**, both against the same SQLite table
(`data/cache.sqlite`, via `src/cache/db.ts` / `cacheStore.ts`):
- Per-endpoint caches (wishlist list, Steam price, ITAD lookup, ITAD prices/historylow) — each
  with its own TTL from `config.cacheTtl`. The historylow caches are additionally keyed by
  `historyYears`, since the same game has a different low price per window.
- A **per-game 24h cache** (`CACHE_TTL_GAME_SEC`) of the fully-enriched `WishlistGame`, keyed by
  `wishlist:game:v2:{countryCode}:{historyYears}y:{appid}`. This is the layer that actually protects
  against hitting Steam/ITAD rate limits — only games whose entry has expired (for the requested
  `historyYears`) trigger new upstream calls, independent of anything else.
- `getOrFetch()` is the shared read-through-cache helper used everywhere; `forceRefresh` bypasses
  the *read* but always writes the fresh result back.

**Refresh semantics** (query params on `GET /api/wishlist`), all handled in `wishlist.ts` /
`aggregate.ts` — don't conflate these:
- `refresh=1` — bypasses the wishlist-list cache only; per-game data still comes from the 24h
  cache if fresh.
- `force=1` — implies `refresh=1` **and** bypasses the 24h per-game cache for every game (not
  just stale ones), forcing a full re-fetch of price + ITAD data for the whole wishlist.
- `debug=0` / `limit=N` — only meaningful when `DEBUG_GAME_LIMIT` is set server-side
  (`debugCapable`); lets the client narrow or lift the server-configured cap on how many on-sale
  wishlist games get enriched, for fast local iteration on a large wishlist.
- `years=N` — scopes the price-history-low lookback used for `historyLowPrice`/`isLowestEver`:
  `1` = past year (default), `2` = past two years, etc.; `0` = all-time. Always available
  (not gated behind `debugCapable`), though the UI control for it lives in the debug panel.
  Echoed back as `historyYears` on the response so the client can reflect the active window.

**Rate limiting:** Steam's storefront API and ITAD's API are each throttled independently via
`createRateLimiter()` (`src/utils/concurrency.ts`), which spaces out calls to a shared resource
to a minimum interval regardless of concurrent callers. `src/utils/http.ts`'s `fetchJson` adds
retry-with-backoff on top, but only for 429/5xx — a 403 is treated as non-retryable and fails
immediately. Steam's storefront endpoint in particular can 403 an entire IP after an unspaced
burst (Akamai bot protection); because step 2 of the aggregation pipeline sweeps the *full*
wishlist every time its cache goes cold, this is a real, recurring risk (not just theoretical —
it has tripped in practice on a ~300-game wishlist). The spacing between Steam storefront calls
is tunable via `STEAM_PRICE_THROTTLE_MS` (`config.steamPriceThrottleMs`, default 1000ms, shared
across all `CONCURRENCY` workers in `aggregate.ts`) — raise it if 429s persist at the default.
`fetchSteamPrice` (`services/steamStore.ts`)
lets such failures propagate rather than swallowing them; `getWishlistData` catches them per-game,
excludes that game from the response for this request (it's simply missing from the on-sale
count, not shown as "unavailable"), and negative-caches the failure for a short TTL
(`CACHE_TTL_STEAM_PRICE_FAILURE_SEC`, default 120s) — long enough that an immediate page reload
doesn't re-hammer Steam for the same game, short enough that the failure isn't mistaken for a real
"no price data" result anywhere near the full `steamPriceSec` TTL. **Do not** revert to caching a
caught fetch error under the normal-TTL price cache key — that turned a several-second Akamai
block into an hour of every game silently looking not-on-sale (see git history around the
sale-filter/negative-cache fixes for the incident this guards against).

**Frontend:** `public/app.ts` (compiled to `app.js` via esbuild, no framework) fetches
`/api/wishlist` and renders the game list plus the debug controls when `debugCapable` is true.
Default sort is price ascending; a View icon-button toggle (grid/list icons, rightmost in the
controls bar) switches between card and compact list layouts (`.list-view` class on
`#game-list`, styled in `styles.css`). There is no client-side "on sale
only" filter — the server only ever returns on-sale games, per the pipeline above.
`public/index.html` / `styles.css` are static, not templated server-side.

The controls bar (`.controls`) stacks three rows (`.controls-row`): sort/search/refresh/view-toggle,
then the ITAD/potential-purchase filter checkboxes, then the debug panel. Refresh is an icon-only
button (`.icon-btn`); Force Refresh stays a labeled text button since it's the higher-stakes action.
Debug control values (debug mode, game limit, history years) are persisted to `localStorage`
(`wishlist:debugControls`) only when the **Save** button in the debug row is clicked — not on every
change — and are restored from there (instead of from the server's `debugGameLimit`/`historyYears`
defaults) on subsequent loads, including real browser reloads, via `loadSavedDebugControls()` /
`pendingDebugReload` in `app.ts`. Dates (`formatDate`) render as `d MMM yyyy` (e.g. `13 Aug 2026`),
not a numeric format.
