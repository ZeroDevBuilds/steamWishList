import { Router } from "express";
import { getWishlistData } from "../services/aggregate.js";
import { fetchWishlistRaw } from "../services/steamWishlist.js";
import { logger } from "../utils/logger.js";

export const wishlistRouter = Router();

wishlistRouter.get("/wishlist", async (req, res) => {
  const forceRefresh = req.query.refresh === "1";
  try {
    const data = await getWishlistData({ forceRefresh });
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
