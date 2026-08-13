import { Router } from "express";
import { getWishlistData } from "../services/aggregate.js";
import { fetchWishlistRaw } from "../services/steamWishlist.js";
import { logger } from "../utils/logger.js";

export const wishlistRouter = Router();

wishlistRouter.get("/wishlist", async (req, res) => {
  // force=1 (Force Refresh) implies refresh=1 and additionally bypasses the 24h per-game
  // cache for every game, not just stale ones — refresh=1 alone only bypasses the wishlist
  // list cache and leaves fresh (<24h) per-game data untouched.
  const forceAllGames = req.query.force === "1";
  const forceRefresh = forceAllGames || req.query.refresh === "1";
  // debug=0 explicitly disables the server-side game limit for this request (fetch everything).
  // limit=N explicitly overrides it. Neither present falls back to the server default (undefined).
  let debugGameLimit: number | null | undefined;
  if (req.query.debug === "0") {
    debugGameLimit = null;
  } else if (typeof req.query.limit === "string" && req.query.limit.trim() !== "") {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit >= 0) {
      debugGameLimit = parsedLimit;
    }
  }
  try {
    const data = await getWishlistData({ forceRefresh, forceAllGames, debugGameLimit });
    res.json(data);
  } catch (err) {
    logger.error("Failed to build wishlist response", err);
    res.status(502).json({ error: "Failed to fetch wishlist data. See server logs for details." });
  }
});

// Temporary debug route (M1) — confirms the real IWishlistService/GetWishlist/v1
// response shape for this account. Safe to delete once verified.
wishlistRouter.get("/debug/wishlist-raw", async (_req, res) => {
  try {
    const raw = await fetchWishlistRaw();
    res.json(raw);
  } catch (err) {
    logger.error("Debug wishlist fetch failed", err);
    res.status(502).json({ error: String(err) });
  }
});
