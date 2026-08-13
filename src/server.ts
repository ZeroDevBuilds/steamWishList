import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { wishlistRouter } from "./routes/wishlist.js";
import { logger } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use("/api", wishlistRouter);
app.use(express.static(join(__dirname, "../public")));

app.listen(config.port, config.host, () => {
  logger.info(`Steam wishlist tracker listening on http://${config.host}:${config.port}`);
});
