CREATE TYPE "BlueprintDocumentStatus" AS ENUM (
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'READY_FOR_APPROVAL',
  'NEEDS_REVIEW',
  'APPROVED',
  'FAILED'
);

CREATE TYPE "BlueprintPrimaryLanguageSource" AS ENUM (
  'UPLOAD_METADATA',
  'INFERRED',
  'USER_CONFIRMED',
  'UNRESOLVED'
);

ALTER TYPE "WorkflowType" ADD VALUE IF NOT EXISTS 'BLUEPRINT_INGESTION';

CREATE TABLE "blueprint_documents" (
  "id" TEXT NOT NULL,
  "upload_object_id" TEXT NOT NULL,
  "original_filename" TEXT NOT NULL,
  "title" TEXT,
  "document_type" TEXT,
  "board" TEXT NOT NULL DEFAULT 'General',
  "subject" TEXT,
  "academic_level" TEXT,
  "detected_languages" JSONB,
  "primary_language" TEXT,
  "primary_language_source" "BlueprintPrimaryLanguageSource" NOT NULL DEFAULT 'UNRESOLVED',
  "language_detection_metadata" JSONB,
  "status" "BlueprintDocumentStatus" NOT NULL DEFAULT 'UPLOADED',
  "page_count" INTEGER,
  "draft_rules_json" JSONB,
  "approved_rules_json" JSONB,
  "raw_extraction_json" JSONB,
  "extraction_metadata_json" JSONB,
  "confidence_summary_json" JSONB,
  "extraction_error" TEXT,
  "review_version" INTEGER NOT NULL DEFAULT 0,
  "approved_at" TIMESTAMP(3),
  "approved_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "blueprint_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blueprint_ocr_pages" (
  "id" TEXT NOT NULL,
  "blueprint_document_id" TEXT NOT NULL,
  "page_number" INTEGER NOT NULL,
  "markdown_text" TEXT NOT NULL,
  "plain_text" TEXT,
  "detected_languages" JSONB,
  "ocr_confidence" DOUBLE PRECISION,
  "provider_metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "blueprint_ocr_pages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workflow_runs" ADD COLUMN "blueprint_document_id" TEXT;

CREATE UNIQUE INDEX "blueprint_documents_upload_object_id_key" ON "blueprint_documents"("upload_object_id");
CREATE INDEX "blueprint_documents_board_idx" ON "blueprint_documents"("board");
CREATE INDEX "blueprint_documents_status_created_at_idx" ON "blueprint_documents"("status", "created_at");
CREATE UNIQUE INDEX "blueprint_ocr_pages_blueprint_document_id_page_number_key" ON "blueprint_ocr_pages"("blueprint_document_id", "page_number");
CREATE INDEX "blueprint_ocr_pages_blueprint_document_id_page_number_idx" ON "blueprint_ocr_pages"("blueprint_document_id", "page_number");
CREATE INDEX "workflow_runs_blueprint_document_id_idx" ON "workflow_runs"("blueprint_document_id");

ALTER TABLE "blueprint_documents"
  ADD CONSTRAINT "blueprint_documents_upload_object_id_fkey"
  FOREIGN KEY ("upload_object_id") REFERENCES "upload_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "blueprint_ocr_pages"
  ADD CONSTRAINT "blueprint_ocr_pages_blueprint_document_id_fkey"
  FOREIGN KEY ("blueprint_document_id") REFERENCES "blueprint_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_blueprint_document_id_fkey"
  FOREIGN KEY ("blueprint_document_id") REFERENCES "blueprint_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
