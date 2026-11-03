import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const healthHandler = (_req: any, res: any) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);
router.get("/submission-stats", async (_req: any, res: any) => {
  try {
    const { pool } = await import("@workspace/db");
    const [overall, review, byCampaign] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int as total_submissions,
          ROUND(AVG(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as avg_minutes,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as median_minutes,
          ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as p25_minutes,
          ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as p75_minutes,
          ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as p90_minutes,
          ROUND(MIN(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as min_minutes,
          ROUND(MAX(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as max_minutes,
          ROUND(AVG(CASE WHEN s.submitted_at >= NOW() - INTERVAL '24 hours' THEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 END)::numeric, 2)::float as avg_24h_minutes,
          COUNT(CASE WHEN s.submitted_at >= NOW() - INTERVAL '24 hours' THEN 1 END)::int as count_24h,
          ROUND(AVG(CASE WHEN s.submitted_at >= NOW() - INTERVAL '7 days' THEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 END)::numeric, 2)::float as avg_7d_minutes,
          COUNT(CASE WHEN s.submitted_at >= NOW() - INTERVAL '7 days' THEN 1 END)::int as count_7d,
          COUNT(CASE WHEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 < 5 THEN 1 END)::int as under_5m,
          COUNT(CASE WHEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 BETWEEN 5 AND 15 THEN 1 END)::int as between_5_15m,
          COUNT(CASE WHEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 BETWEEN 15 AND 30 THEN 1 END)::int as between_15_30m,
          COUNT(CASE WHEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 BETWEEN 30 AND 60 THEN 1 END)::int as between_30_60m,
          COUNT(CASE WHEN EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60 > 60 THEN 1 END)::int as over_60m
        FROM submissions s
        JOIN claims c ON s.claim_id = c.id
        WHERE s.submitted_at >= c.claimed_at
      `),
      pool.query(`
        SELECT
          COUNT(*)::int as total_reviewed,
          ROUND(AVG(EXTRACT(EPOCH FROM (s.reviewed_at - s.submitted_at)) / 60)::numeric, 2)::float as avg_review_minutes,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.reviewed_at - s.submitted_at)) / 60)::numeric, 2)::float as median_review_minutes
        FROM submissions s
        WHERE s.reviewed_at IS NOT NULL AND s.reviewed_at >= s.submitted_at
      `),
      pool.query(`
        SELECT
          COALESCE(camp.title, 'Individual Tasks') as campaign_title,
          COUNT(*)::int as submission_count,
          ROUND(AVG(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as avg_minutes,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)) / 60)::numeric, 2)::float as median_minutes
        FROM submissions s
        JOIN claims c ON s.claim_id = c.id
        JOIN tasks t ON s.task_id = t.id
        LEFT JOIN campaigns camp ON t.campaign_id = camp.id
        WHERE s.submitted_at >= c.claimed_at
        GROUP BY COALESCE(camp.title, 'Individual Tasks')
        ORDER BY submission_count DESC
        LIMIT 10
      `),
    ]);

    res.json({
      claim_to_submit: overall.rows[0],
      review_time: review.rows[0],
      campaigns: byCampaign.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
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
