import { Router } from "express";
import { buildAuthorizeUrl, exchangeCodeForToken } from "../integrations/hubspot/oauth";
import { hubspotGet } from "../integrations/hubspot/client";

const router = Router();

router.get("/oauth/hubspot/authorize", (_req, res) => {
  res.redirect(buildAuthorizeUrl());
});

router.get("/oauth/hubspot/callback", async (req, res) => {
  const code = req.query.code;
  if (typeof code !== "string") {
    res.status(400).json({ error: "Missing code param" });
    return;
  }
  try {
    await exchangeCodeForToken(code);
    res.status(200).json({ status: "connected" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Manual test route: confirms a valid HubSpot API call works post-auth.
router.get("/oauth/hubspot/test", async (_req, res) => {
  try {
    const data = await hubspotGet("/crm/v3/objects/contacts?limit=1");
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
