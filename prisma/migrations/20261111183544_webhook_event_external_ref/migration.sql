-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "external_ref" TEXT;

-- CreateIndex
CREATE INDEX "webhook_events_external_ref_received_at_idx" ON "webhook_events"("external_ref", "received_at");

-- Back-fill (spec 2, IA14): the same rule as src/events/external-ref.ts.
-- <repository.full_name>#<number>, the number from `issue` or, when there is no issue object, from
-- `pull_request`; a missing or wrongly typed field leaves the column empty. Writes only this column.
WITH "candidates" AS (
    SELECT
        "id",
        CASE WHEN jsonb_typeof("payload" #> '{repository,full_name}') = 'string'
            THEN "payload" #>> '{repository,full_name}' END AS "full_name",
        CASE
            WHEN jsonb_typeof("payload" -> 'issue') = 'object' THEN "payload" -> 'issue' -> 'number'
            WHEN jsonb_typeof("payload" -> 'pull_request') = 'object' THEN "payload" -> 'pull_request' -> 'number'
        END AS "number_json"
    FROM "webhook_events"
    WHERE "external_ref" IS NULL
), "parsed" AS (
    SELECT
        "id",
        "full_name",
        CASE WHEN jsonb_typeof("number_json") = 'number' THEN ("number_json" #>> '{}')::numeric END AS "number"
    FROM "candidates"
)
UPDATE "webhook_events" AS "e"
SET "external_ref" = "p"."full_name" || '#' || "p"."number"::bigint::text
FROM "parsed" AS "p"
WHERE "e"."id" = "p"."id"
    AND "p"."full_name" <> ''
    AND "p"."number" >= 1
    AND "p"."number" <= 9007199254740991
    AND "p"."number" = trunc("p"."number");
