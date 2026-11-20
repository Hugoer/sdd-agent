-- Spec 11 ("Owned table: ContextLoad", "Changes to ExecutionLog"; plan P14): the context_loads table and five
-- execution_logs columns. Rows written before spec 11 get turn = attempt (SDW13) and an empty call_id.

-- AlterTable
ALTER TABLE "execution_logs" ADD COLUMN     "agents_chars" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "call_id" UUID,
ADD COLUMN     "lists_chars" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loaded_chars" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "turn" INTEGER NOT NULL DEFAULT 1;

-- Spec 4's rows: one row per attempt, so their request number is their attempt (SDW13).
UPDATE "execution_logs" SET "turn" = "attempt";

-- CreateTable
CREATE TABLE "context_loads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "run_id" TEXT,
    "step" TEXT NOT NULL,
    "call_id" UUID NOT NULL,
    "turn" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "tool" TEXT,
    "requested" TEXT,
    "reason" TEXT,
    "kind" TEXT,
    "skill" TEXT,
    "path" TEXT,
    "commit" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bytes" INTEGER,
    "chars" INTEGER,
    "tokens" INTEGER,
    "estimated_tokens" INTEGER,
    "injection_kinds" TEXT[],

    CONSTRAINT "context_loads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "context_loads_call_id_idx" ON "context_loads"("call_id");

-- CreateIndex
CREATE INDEX "context_loads_platform_task_id_created_at_idx" ON "context_loads"("platform", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "context_loads_path_commit_model_idx" ON "context_loads"("path", "commit", "model");

-- CreateIndex
CREATE INDEX "execution_logs_call_id_turn_idx" ON "execution_logs"("call_id", "turn");
