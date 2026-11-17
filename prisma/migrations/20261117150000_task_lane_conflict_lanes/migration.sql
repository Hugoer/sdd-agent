-- Spec 5, plan Q3 (decided at Checkpoint 2, 2026-11-16; added 2026-11-17 in Task 18): one lane-conflict reminder
-- per set of labels. `lane_conflict_lanes` (the lanes the open reminder lists) replaces the `lane_conflict_open`
-- flag. No reminder was posted before this migration (Task 18 builds them), so no open conflict is lost.

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "lane_conflict_open",
ADD COLUMN     "lane_conflict_lanes" TEXT[] DEFAULT ARRAY[]::TEXT[];
