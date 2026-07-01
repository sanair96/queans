WITH ranked_provider_costs AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workflow_run_id", "operation"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS "row_number"
  FROM "provider_run_costs"
)
DELETE FROM "provider_run_costs"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_provider_costs
  WHERE "row_number" > 1
);

CREATE UNIQUE INDEX "provider_run_costs_workflow_run_id_operation_key"
  ON "provider_run_costs"("workflow_run_id", "operation");
