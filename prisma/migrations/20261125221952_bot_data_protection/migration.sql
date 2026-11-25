-- AlterTable
ALTER TABLE "execution_logs" ADD COLUMN     "secret_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[];
