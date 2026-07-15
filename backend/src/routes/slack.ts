import express, { Router } from "express";
import { handleSlackCallback } from "../approval/slackCallbacks";

const router = Router();

// Slack posts interactivity payloads as application/x-www-form-urlencoded
// (a "payload" field containing JSON) — separate from the app-wide
// express.json() middleware, and needs its own raw-body capture for
// signature verification.
router.post(
  "/webhooks/slack/callback",
  express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
  handleSlackCallback,
);

export default router;
