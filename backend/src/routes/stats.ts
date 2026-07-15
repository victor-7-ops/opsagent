import { Router } from "express";
import { getWorkflowStats } from "../workflow/stats";

const router = Router();

router.get("/stats", async (_req, res) => {
  const stats = await getWorkflowStats();
  res.status(200).json(stats);
});

export default router;
