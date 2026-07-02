ALTER TABLE "review_items" ADD COLUMN "workflow_run_id" TEXT;

UPDATE "review_items" AS "review_item"
SET "workflow_run_id" = (
  SELECT "workflow_runs"."id"
  FROM "workflow_runs"
  WHERE
    "workflow_runs"."source_paper_id" = "review_item"."source_paper_id"
    AND "workflow_runs"."workflow_type" = 'PAPER_INGESTION'
    AND "workflow_runs"."created_at" <= "review_item"."created_at"
  ORDER BY "workflow_runs"."created_at" DESC, "workflow_runs"."id" DESC
  LIMIT 1
);

ALTER TABLE "review_items" ALTER COLUMN "workflow_run_id" SET NOT NULL;

ALTER TABLE "review_items"
  ADD CONSTRAINT "review_items_workflow_run_id_fkey"
  FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "review_items_workflow_run_id_status_idx"
  ON "review_items"("workflow_run_id", "status");
