-- CreateEnum
CREATE TYPE "ProviderBatchJobStatus" AS ENUM ('SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'IMPORTING', 'IMPORTED', 'IMPORT_FAILED');

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN "retry_of_workflow_run_id" TEXT;

-- CreateTable
CREATE TABLE "provider_batch_jobs" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "source_paper_id" TEXT,
    "retry_of_batch_job_id" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "ProviderBatchJobStatus" NOT NULL DEFAULT 'SUBMITTED',
    "input_file_id" TEXT,
    "provider_job_id" TEXT,
    "output_file_id" TEXT,
    "error_file_id" TEXT,
    "total_requests" INTEGER,
    "succeeded_requests" INTEGER,
    "failed_requests" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),
    "import_error" JSONB,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_batch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_batch_jobs_provider_job_id_idx" ON "provider_batch_jobs"("provider_job_id");

-- CreateIndex
CREATE INDEX "provider_batch_jobs_workflow_run_id_operation_idx" ON "provider_batch_jobs"("workflow_run_id", "operation");

-- CreateIndex
CREATE INDEX "provider_batch_jobs_source_paper_id_operation_idx" ON "provider_batch_jobs"("source_paper_id", "operation");

-- CreateIndex
CREATE INDEX "provider_batch_jobs_status_created_at_idx" ON "provider_batch_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "provider_batch_jobs_retry_of_batch_job_id_idx" ON "provider_batch_jobs"("retry_of_batch_job_id");

-- CreateIndex
CREATE INDEX "workflow_runs_retry_of_workflow_run_id_idx" ON "workflow_runs"("retry_of_workflow_run_id");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_retry_of_workflow_run_id_fkey" FOREIGN KEY ("retry_of_workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_batch_jobs" ADD CONSTRAINT "provider_batch_jobs_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_batch_jobs" ADD CONSTRAINT "provider_batch_jobs_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "source_papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_batch_jobs" ADD CONSTRAINT "provider_batch_jobs_retry_of_batch_job_id_fkey" FOREIGN KEY ("retry_of_batch_job_id") REFERENCES "provider_batch_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
