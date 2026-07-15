import { Router } from "express";
import { runExpirySweep } from "../workflow/expirySweep";

const router = Router();

function verifyInternalKey(header: string | undefined): boolean {
  const expected = process.env.INTERNAL_API_KEY;
  return Boolean(expected) && header === expected;
}

// Called by an n8n Schedule Trigger every 15 min (n8n/workflows/expiry-sweep.json).
router.post("/internal/workflows/expire-sweep", async (req, res) => {
  if (!verifyInternalKey(req.header("X-Internal-Api-Key"))) {
    res.status(401).json({ error: "Invalid or missing X-Internal-Api-Key" });
    return;
  }

  const result = await runExpirySweep();
  res.status(200).json(result);
});

export default router;
