-- Spec 5, plan Q2 (decided at Checkpoint 2, 2026-11-16; added 2026-11-17 in Task 17): the event that ended a run,
-- so a run-ended comment posted later by another event still names who changed the label. Adds one nullable
-- column; nothing existing changes.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "end_event_id" UUID;
