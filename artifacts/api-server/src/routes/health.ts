import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const healthHandler = (_req: any, res: any) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);
router.get("/version", (_req: any, res: any) => {
  res.json({
    version: "2.1.0-referral-v2",
    uptimeSeconds: Math.floor(process.uptime()),
    rewards: {
      referrer: "0.30",
      referred: "0.20",
    },
    buildTime: "2026-11-02T00:48:00+05:30"
  });
});

export default router;
