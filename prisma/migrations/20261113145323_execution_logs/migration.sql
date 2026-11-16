-- Spec 4 (L11): one row per model call attempt, only ever inserted by the app. Creates one table and two
-- indexes; nothing existing changes.

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "run_id" TEXT,
    "lane" TEXT,
    "step" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "model_level" TEXT NOT NULL,
    "skill_commit" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "frame_chars" INTEGER NOT NULL,
    "skill_chars" INTEGER NOT NULL,
    "untrusted_chars" INTEGER NOT NULL,
    "other_chars" INTEGER NOT NULL,
    "answer_chars" INTEGER,
    "injection_kinds" TEXT[],
    "cut_sources" TEXT[],
    "prompt" JSONB NOT NULL,
    "answer" JSONB,
    "provider_usage" JSONB,
    "provider_meta" JSONB,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_logs_platform_task_id_created_at_idx" ON "execution_logs"("platform", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "execution_logs_step_model_idx" ON "execution_logs"("step", "model");
