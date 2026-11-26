-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "working_event_id" UUID;

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "working_ended_at" TIMESTAMPTZ,
ADD COLUMN     "working_started_at" TIMESTAMPTZ;

-- Data (spec 13 BFW11, plan FP11): a full-sdd run whose current Plan (the latest plan row not superseded) waits
-- unapproved under ready-for-dev now waits under plan-review; the same for a stopped run's status before the stop.
-- shown_status is left as is, so the startup sweep repairs the label (BF7). code-only, spec-code and approved Plans
-- keep ready-for-dev; a full-sdd run with no Plan row keeps its status.
UPDATE "tasks" AS t SET "status" = 'plan-review'
FROM "runs" AS r
WHERE r."id" = t."current_run_id"
  AND t."status" = 'ready-for-dev'
  AND r."lane" = 'full-sdd'
  AND (
    SELECT d."approved_at" IS NULL FROM "task_documents" AS d
    WHERE d."run_id" = r."id" AND d."kind" = 'plan' AND d."superseded_at" IS NULL
    ORDER BY d."created_at" DESC LIMIT 1
  );

UPDATE "runs" AS r SET "status_before_stop" = 'plan-review'
FROM "tasks" AS t
WHERE t."current_run_id" = r."id"
  AND r."status_before_stop" = 'ready-for-dev'
  AND r."lane" = 'full-sdd'
  AND (
    SELECT d."approved_at" IS NULL FROM "task_documents" AS d
    WHERE d."run_id" = r."id" AND d."kind" = 'plan' AND d."superseded_at" IS NULL
    ORDER BY d."created_at" DESC LIMIT 1
  );
