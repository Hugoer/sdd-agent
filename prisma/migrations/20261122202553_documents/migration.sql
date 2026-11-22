-- Spec 7 ("Owned tables"; plan P12 adds task_documents.notes, plan P33 changed_paths): every version of a Spec,
-- a Plan or a go-signal, and every human action spec 7 answered. Creates two tables, their indexes and their
-- foreign keys; nothing existing changes.

-- CreateTable
CREATE TABLE "task_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "based_on_id" UUID,
    "commit" TEXT,
    "checked_commit" TEXT,
    "log_id" UUID,
    "text" TEXT NOT NULL,
    "changes" TEXT[],
    "notes" TEXT[],
    "trigger_comment_id" TEXT,
    "body" TEXT NOT NULL,
    "post_state" TEXT NOT NULL,
    "comment_id" TEXT,
    "comment_url" TEXT,
    "posted_at" TIMESTAMPTZ,
    "superseded_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" TEXT,
    "deleted_text" TEXT,
    "approved_text" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ,
    "approve_event_id" UUID,
    "approve_comment_id" TEXT,
    "approved_commit" TEXT,
    "stale_files" TEXT[],
    "changed_files" INTEGER,
    "changed_paths" TEXT[],
    "changed_complete" BOOLEAN,
    "lines_added" INTEGER,
    "lines_removed" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "run_id" UUID,
    "document_id" UUID,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "source_comment_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "log_ids" UUID[],
    "reply_body" TEXT,
    "reply_post_state" TEXT,
    "reply_comment_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_documents_run_id_kind_version_idx" ON "task_documents"("run_id", "kind", "version");

-- CreateIndex
CREATE INDEX "task_documents_comment_id_idx" ON "task_documents"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_documents_run_id_kind_trigger_comment_id_key" ON "task_documents"("run_id", "kind", "trigger_comment_id");

-- CreateIndex
CREATE INDEX "document_actions_run_id_created_at_idx" ON "document_actions"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_actions_action_source_comment_id_key" ON "document_actions"("action", "source_comment_id");

-- AddForeignKey
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_based_on_id_fkey" FOREIGN KEY ("based_on_id") REFERENCES "task_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_actions" ADD CONSTRAINT "document_actions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_actions" ADD CONSTRAINT "document_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_actions" ADD CONSTRAINT "document_actions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "task_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
