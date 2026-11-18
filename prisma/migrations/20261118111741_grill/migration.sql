-- Spec 6 ("Owned tables"; plan P2 adds grill_evaluations.notes): Grill Me's session, evaluations, rounds and
-- answers. Creates four tables, their indexes and their foreign keys; nothing existing changes.

-- CreateTable
CREATE TABLE "grill_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "last_question" INTEGER NOT NULL DEFAULT 0,
    "first_confidence" INTEGER,
    "last_confidence" INTEGER,
    "stopped_by" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "grill_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grill_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "log_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "model_level" TEXT NOT NULL,
    "after_round" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "questions_proposed" INTEGER NOT NULL,
    "open" INTEGER[],
    "gaps" TEXT[],
    "notes" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grill_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grill_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "log_id" UUID NOT NULL,
    "questions" JSONB NOT NULL,
    "still_open" INTEGER[],
    "body" TEXT NOT NULL,
    "post_state" TEXT NOT NULL,
    "comment_id" TEXT,
    "comment_url" TEXT,
    "posted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grill_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grill_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "evaluation_id" UUID,
    "after_round" INTEGER NOT NULL,
    "comment_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "read_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "grill_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "grill_sessions_run_id_key" ON "grill_sessions"("run_id");

-- CreateIndex
CREATE INDEX "grill_sessions_task_id_started_at_idx" ON "grill_sessions"("task_id", "started_at");

-- CreateIndex
CREATE INDEX "grill_evaluations_session_id_created_at_idx" ON "grill_evaluations"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "grill_rounds_evaluation_id_key" ON "grill_rounds"("evaluation_id");

-- CreateIndex
CREATE UNIQUE INDEX "grill_rounds_session_id_number_key" ON "grill_rounds"("session_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "grill_answers_session_id_comment_id_key" ON "grill_answers"("session_id", "comment_id");

-- AddForeignKey
ALTER TABLE "grill_sessions" ADD CONSTRAINT "grill_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_sessions" ADD CONSTRAINT "grill_sessions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_evaluations" ADD CONSTRAINT "grill_evaluations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "grill_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_rounds" ADD CONSTRAINT "grill_rounds_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "grill_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_rounds" ADD CONSTRAINT "grill_rounds_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "grill_evaluations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_answers" ADD CONSTRAINT "grill_answers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "grill_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grill_answers" ADD CONSTRAINT "grill_answers_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "grill_evaluations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

