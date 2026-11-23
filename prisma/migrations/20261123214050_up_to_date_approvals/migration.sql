-- AlterTable
ALTER TABLE "document_actions" ADD COLUMN     "changed_files" INTEGER,
ADD COLUMN     "files" JSONB,
ADD COLUMN     "files_complete" BOOLEAN,
ADD COLUMN     "from_commit" TEXT,
ADD COLUMN     "reply_comment_url" TEXT,
ADD COLUMN     "reply_posted_at" TIMESTAMPTZ,
ADD COLUMN     "to_commit" TEXT;

-- AlterTable
ALTER TABLE "task_documents" ADD COLUMN     "approved_from_commit" TEXT,
ADD COLUMN     "asked_commit" TEXT;
