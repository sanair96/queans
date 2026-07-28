CREATE TYPE "BlueprintDocumentStatus_new" AS ENUM (
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED'
);

ALTER TABLE "blueprint_documents"
  ALTER COLUMN "status" DROP DEFAULT;

UPDATE "blueprint_documents"
SET "draft_rules_json" = COALESCE("approved_rules_json", "draft_rules_json")
WHERE "status" = 'APPROVED';

ALTER TABLE "blueprint_documents"
  ALTER COLUMN "status" TYPE "BlueprintDocumentStatus_new"
  USING (
    CASE
      WHEN "status"::text IN ('READY_FOR_APPROVAL', 'APPROVED') THEN 'READY'
      ELSE "status"::text
    END
  )::"BlueprintDocumentStatus_new";

ALTER TABLE "blueprint_documents"
  ALTER COLUMN "status" SET DEFAULT 'UPLOADED';

DROP TYPE "BlueprintDocumentStatus";
ALTER TYPE "BlueprintDocumentStatus_new" RENAME TO "BlueprintDocumentStatus";

ALTER TABLE "blueprint_documents"
  DROP COLUMN "approved_rules_json",
  DROP COLUMN "approved_at",
  DROP COLUMN "approved_by";
