import { Router } from "express";
import { handleTelegramCallback } from "../approval/callbacks";

const router = Router();

router.post("/webhooks/telegram/callback", handleTelegramCallback);

export default router;
