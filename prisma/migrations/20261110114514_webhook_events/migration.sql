-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delivery_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL,
    "status" "webhook_event_status" NOT NULL DEFAULT 'PENDING',
    "ignore_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_delivery_id_key" ON "webhook_events"("delivery_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_available_at_received_at_idx" ON "webhook_events"("status", "available_at", "received_at");
