import { Router } from "express";
import { prisma } from "../db/client";
import { verifyHubspotSignatureV3 } from "../integrations/hubspot/signature";

const router = Router();

interface HubspotWebhookEvent {
  subscriptionType: string;
  objectId: number;
  occurredAt: number;
}

router.post("/webhooks/hubspot/lead", async (req, res) => {
  const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
  const requestUri = process.env.HUBSPOT_WEBHOOK_TARGET_URL || req.originalUrl;
  const signatureValid = verifyHubspotSignatureV3(
    req.method,
    requestUri,
    rawBody,
    req.header("X-HubSpot-Request-Timestamp"),
    req.header("X-HubSpot-Signature-v3"),
  );

  if (!signatureValid) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const events = req.body as HubspotWebhookEvent[];
  if (!Array.isArray(events)) {
    res.status(400).json({ error: "Expected an array of events" });
    return;
  }

  for (const event of events) {
    if (event.subscriptionType !== "object.creation") continue;

    await prisma.lead.upsert({
      where: { hubspotId: String(event.objectId) },
      update: {},
      create: {
        hubspotId: String(event.objectId),
        status: "received",
      },
    });

    await prisma.activityLog.create({
      data: {
        type: "lead.received",
        refId: String(event.objectId),
        payload: event as unknown as object,
      },
    });
  }

  res.status(200).json({ status: "ok" });
});

export default router;
