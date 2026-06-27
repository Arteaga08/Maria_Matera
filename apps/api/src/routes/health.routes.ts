import { Router } from "express";
import mongoose from "mongoose";
import { sendResponse } from "../utils/sendResponse.js";

/**
 * Liveness/readiness probe. Reports process uptime and the MongoDB connection
 * state so the hosting platform can health-check the API.
 */

const router = Router();

const DB_STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
  99: "uninitialized",
};

router.get("/", (_req, res) => {
  const database = DB_STATES[mongoose.connection.readyState] ?? "unknown";

  sendResponse({
    res,
    message: "API operativa",
    data: {
      uptime: Math.round(process.uptime()),
      database,
      timestamp: new Date().toISOString(),
    },
  });
});

export { router as healthRouter };
