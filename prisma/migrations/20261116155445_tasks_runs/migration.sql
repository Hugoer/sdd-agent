-- Spec 5 (D24, "Owned tables"; plan Q1 adds runs.end_comment_id): one row per issue and one per run. Creates
-- two tables, their indexes and the two foreign keys between them; nothing existing changes.

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "platform" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "shown_status" TEXT,
    "current_run_id" UUID,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" UUID,
    "lease_expires_at" TIMESTAMPTZ,
    "lane_conflict_open" BOOLEAN NOT NULL DEFAULT false,
    "lane_conflicts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "lane" TEXT NOT NULL,
    "grill_skip" BOOLEAN NOT NULL,
    "start_event_id" UUID NOT NULL,
    "start_event_received_at" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "end_reason" TEXT,
    "stopped_at" TIMESTAMPTZ,
    "stop_step" TEXT,
    "stop_cause" TEXT,
    "stop_message" TEXT,
    "stop_retryable" BOOLEAN,
    "stop_event_id" UUID,
    "status_before_stop" TEXT,
    "stop_comment_id" TEXT,
    "end_comment_id" TEXT,
    "stops" INTEGER NOT NULL DEFAULT 0,
    "retries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tasks_current_run_id_key" ON "tasks"("current_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_platform_platform_id_key" ON "tasks"("platform", "platform_id");

-- CreateIndex
CREATE INDEX "runs_task_id_started_at_idx" ON "runs"("task_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "runs_task_id_number_key" ON "runs"("task_id", "number");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_run_id_fkey" FOREIGN KEY ("current_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
