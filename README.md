# Steam Wishlist Price Tracker

Lists the games on your Steam wishlist that are currently on sale, sorted by
lowest price, and flags whether the current price is the lowest that game has
ever been (via [IsThereAnyDeal](https://isthereanydeal.com)).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `STEAM_ID64` — your 64-bit Steam ID. Find it by pasting your profile URL into https://steamid.io/. Your wishlist must be public.
   - `STEAM_API_KEY` — free key from https://steamcommunity.com/dev/apikey (recommended, may not be strictly required).
   - `ITAD_API_KEY` — free key from https://isthereanydeal.com/apps/my/ (register an app to get one).
3. `npm run dev` — starts the server at http://127.0.0.1:3000 (builds the frontend once first).
   - If you're actively editing `public/app.ts`, run `npm run dev:client` in a second terminal to rebuild it on save.

## Verifying the Steam wishlist response shape

Valve's wishlist API has changed shape before. Before relying on the main
`/api/wishlist` endpoint, hit `http://127.0.0.1:3000/api/debug/wishlist-raw`
and confirm the JSON matches what `src/services/steamWishlist.ts` expects
(`response.items[].appid` etc.). Adjust the parsing there if not, then this
debug route can be deleted.

## Production build

```
npm run build
npm start
```

Reads config from environment variables (see `.env.example`); no other
runtime dependencies beyond Node.js and the `data/cache.sqlite` file, which
is created automatically and should live on a persisted path if deployed to
a server.

## Scripts

- `npm run dev` — local dev server (auto-restarts on server changes)
- `npm run dev:client` — rebuilds `public/app.js` on save (separate terminal)
- `npm run build` — compiles server to `dist/` and bundles the client
- `npm start` — runs the compiled build
