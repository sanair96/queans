-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourcePaperStatus" AS ENUM ('UPLOADED', 'QUEUED', 'PROCESSING', 'WAITING_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowType" AS ENUM ('PAPER_INGESTION', 'PAPER_GENERATION');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_FOR_REVIEW', 'FAILED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'STARTED', 'FAILED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'NUMERICAL', 'TRUE_FALSE', 'FILL_IN_THE_BLANK', 'MATCHING', 'DIAGRAM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'EDITED_AND_APPROVED', 'REJECTED', 'DUPLICATE', 'UNPROCESSABLE');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'APPROVED', 'NEEDS_REVISION', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GeneratedPaperStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'RENDERED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewEntityType" AS ENUM ('QUESTION_CANDIDATE', 'GENERATED_PAPER', 'SOLUTION_SHEET');

-- CreateEnum
CREATE TYPE "ReviewSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'ASSIGNED', 'APPROVED', 'EDITED', 'REJECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'EDIT_AND_APPROVE', 'REJECT', 'SPLIT', 'MERGE', 'MARK_DUPLICATE', 'NEEDS_MORE_INFO', 'MARK_UNPROCESSABLE');

-- CreateEnum
CREATE TYPE "ReviewReason" AS ENUM ('LOW_OCR_CONFIDENCE', 'MISSING_REQUIRED_FIELD', 'LOW_FIELD_CONFIDENCE', 'VALIDATION_FAILED', 'DUPLICATE_CONFLICT', 'ANSWER_UNCERTAIN', 'MATH_OR_DIAGRAM_UNCERTAIN', 'TOPIC_AMBIGUOUS', 'CONTRADICTION_DETECTED', 'MISSING_QUESTION_TEXT', 'MISSING_MARKS', 'MCQ_OPTIONS_MISSING', 'MCQ_CORRECT_ANSWER_MISSING', 'TOPIC_NOT_MAPPED', 'LOW_ANSWER_CONFIDENCE', 'DIAGRAM_ASSET_MISSING', 'LLM_GENERATED_ANSWER_UNVERIFIED', 'LOW_TOPIC_CONFIDENCE');

-- CreateEnum
CREATE TYPE "CorrectionType" AS ENUM ('OCR_ERROR', 'WRONG_TOPIC', 'WRONG_ANSWER', 'WRONG_MARKS', 'BAD_SOLUTION', 'BAD_SEGMENTATION', 'DUPLICATE', 'FORMATTING_ISSUE');

-- CreateEnum
CREATE TYPE "AnswerSourceType" AS ENUM ('SOURCE_KEY', 'LLM_GENERATED', 'HUMAN_VERIFIED');

-- CreateEnum
CREATE TYPE "OcrProvider" AS ENUM ('MISTRAL', 'GOOGLE_DOCUMENT_AI');

-- CreateTable
CREATE TABLE "upload_objects" (
    "id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "checksum_sha256" TEXT,
    "etag" TEXT,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "upload_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_papers" (
    "id" TEXT NOT NULL,
    "upload_object_id" TEXT NOT NULL,
    "title" TEXT,
    "source_file_name" TEXT NOT NULL,
    "status" "SourcePaperStatus" NOT NULL DEFAULT 'UPLOADED',
    "page_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflow_type" "WorkflowType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "source_paper_id" TEXT,
    "temporal_run_id" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'PENDING',
    "current_step" TEXT,
    "input_payload" JSONB NOT NULL,
    "output_payload" JSONB,
    "error_payload" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "step_name" TEXT NOT NULL,
    "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_payload" JSONB,
    "output_payload" JSONB,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_start_outbox" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_start_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_pages" (
    "id" TEXT NOT NULL,
    "source_paper_id" TEXT NOT NULL,
    "provider" "OcrProvider" NOT NULL,
    "page_number" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "plain_text" TEXT,
    "average_confidence" DOUBLE PRECISION,
    "minimum_confidence" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "dpi" INTEGER,
    "raw_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_blocks" (
    "id" TEXT NOT NULL,
    "ocr_page_id" TEXT NOT NULL,
    "block_type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "bounding_box" JSONB,
    "source_asset" JSONB,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtopics" (
    "id" TEXT NOT NULL,
    "topic_id" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtopics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_candidates" (
    "id" TEXT NOT NULL,
    "source_paper_id" TEXT NOT NULL,
    "approved_question_id" TEXT,
    "page_number" INTEGER,
    "source_page_start" INTEGER,
    "source_page_end" INTEGER,
    "question_number" TEXT,
    "section_name" TEXT,
    "raw_ocr_text" TEXT NOT NULL,
    "cleaned_question_text" TEXT NOT NULL,
    "question_type" "QuestionType" NOT NULL DEFAULT 'UNKNOWN',
    "marks" DOUBLE PRECISION,
    "options" JSONB,
    "answer_text" TEXT,
    "solution_text" TEXT,
    "chapter_id" TEXT,
    "topic_id" TEXT,
    "subtopic_id" TEXT,
    "difficulty" TEXT,
    "bloom_level" TEXT,
    "requires_diagram" BOOLEAN NOT NULL DEFAULT false,
    "diagram_asset" JSONB,
    "extracted_payload" JSONB NOT NULL,
    "source_evidence" JSONB NOT NULL,
    "field_confidence" JSONB NOT NULL,
    "overall_confidence" DOUBLE PRECISION NOT NULL,
    "validation_errors" JSONB NOT NULL,
    "review_status" "CandidateStatus" NOT NULL DEFAULT 'EXTRACTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_field_confidences" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason_code" "ReviewReason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_field_confidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_tasks" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "entity_type" "ReviewEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "review_type" TEXT NOT NULL,
    "reason_codes" JSONB NOT NULL,
    "severity" "ReviewSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to" TEXT,
    "reviewed_by" TEXT,
    "review_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_items" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "source_paper_id" TEXT NOT NULL,
    "review_type" TEXT NOT NULL,
    "severity" "ReviewSeverity" NOT NULL DEFAULT 'MEDIUM',
    "reason_codes" JSONB NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to" TEXT,
    "reviewed_by" TEXT,
    "review_notes" TEXT,
    "review_payload" JSONB,
    "decision" "ReviewDecision",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_corrections" (
    "id" TEXT NOT NULL,
    "review_item_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "correction_type" "CorrectionType" NOT NULL,
    "reviewer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "question_text" TEXT NOT NULL,
    "question_type" "QuestionType" NOT NULL,
    "marks" DOUBLE PRECISION,
    "options" JSONB,
    "chapter_id" TEXT,
    "topic_id" TEXT,
    "subtopic_id" TEXT,
    "difficulty" TEXT,
    "bloom_level" TEXT,
    "status" "QuestionStatus" NOT NULL DEFAULT 'APPROVED',
    "source_evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL,
    "question_id" TEXT,
    "candidate_id" TEXT,
    "answer_text" TEXT NOT NULL,
    "solution_text" TEXT,
    "source_type" "AnswerSourceType" NOT NULL,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_matches" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "question_id" TEXT,
    "similarity" DOUBLE PRECISION NOT NULL,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_run_costs" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "page_count" INTEGER,
    "input_token_count" INTEGER,
    "output_token_count" INTEGER,
    "estimated_cost_usd" DECIMAL(12,6),
    "raw_usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_run_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_papers" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT,
    "title" TEXT NOT NULL,
    "requested_schema" JSONB NOT NULL,
    "actual_schema" JSONB,
    "warnings" JSONB,
    "status" "GeneratedPaperStatus" NOT NULL DEFAULT 'DRAFT',
    "rendered_object_key" TEXT,
    "solution_object_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_paper_items" (
    "id" TEXT NOT NULL,
    "generated_paper_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "marks" DOUBLE PRECISION,
    "section_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_paper_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "upload_objects_object_key_key" ON "upload_objects"("object_key");

-- CreateIndex
CREATE INDEX "upload_objects_status_created_at_idx" ON "upload_objects"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_papers_upload_object_id_key" ON "source_papers"("upload_object_id");

-- CreateIndex
CREATE INDEX "source_papers_status_created_at_idx" ON "source_papers"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_temporal_run_id_key" ON "workflow_runs"("temporal_run_id");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_type_status_created_at_idx" ON "workflow_runs"("workflow_type", "status", "created_at");

-- CreateIndex
CREATE INDEX "workflow_runs_entity_id_idx" ON "workflow_runs"("entity_id");

-- CreateIndex
CREATE INDEX "workflow_steps_workflow_run_id_step_name_idx" ON "workflow_steps"("workflow_run_id", "step_name");

-- CreateIndex
CREATE INDEX "workflow_events_workflow_run_id_created_at_idx" ON "workflow_events"("workflow_run_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_events_event_type_created_at_idx" ON "workflow_events"("event_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_start_outbox_workflow_run_id_key" ON "workflow_start_outbox"("workflow_run_id");

-- CreateIndex
CREATE INDEX "workflow_start_outbox_status_created_at_idx" ON "workflow_start_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "ocr_pages_source_paper_id_page_number_idx" ON "ocr_pages"("source_paper_id", "page_number");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_pages_source_paper_id_provider_page_number_key" ON "ocr_pages"("source_paper_id", "provider", "page_number");

-- CreateIndex
CREATE INDEX "ocr_blocks_ocr_page_id_block_type_idx" ON "ocr_blocks"("ocr_page_id", "block_type");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_name_key" ON "chapters"("name");

-- CreateIndex
CREATE UNIQUE INDEX "topics_chapter_id_name_key" ON "topics"("chapter_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "subtopics_topic_id_name_key" ON "subtopics"("topic_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "question_candidates_approved_question_id_key" ON "question_candidates"("approved_question_id");

-- CreateIndex
CREATE INDEX "question_candidates_source_paper_id_review_status_idx" ON "question_candidates"("source_paper_id", "review_status");

-- CreateIndex
CREATE INDEX "question_candidates_chapter_id_topic_id_subtopic_id_idx" ON "question_candidates"("chapter_id", "topic_id", "subtopic_id");

-- CreateIndex
CREATE INDEX "question_candidates_question_type_idx" ON "question_candidates"("question_type");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_field_confidences_candidate_id_field_name_key" ON "candidate_field_confidences"("candidate_id", "field_name");

-- CreateIndex
CREATE INDEX "review_tasks_workflow_run_id_status_idx" ON "review_tasks"("workflow_run_id", "status");

-- CreateIndex
CREATE INDEX "review_tasks_entity_type_entity_id_idx" ON "review_tasks"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "review_items_source_paper_id_status_idx" ON "review_items"("source_paper_id", "status");

-- CreateIndex
CREATE INDEX "review_items_candidate_id_status_idx" ON "review_items"("candidate_id", "status");

-- CreateIndex
CREATE INDEX "review_corrections_review_item_id_field_name_idx" ON "review_corrections"("review_item_id", "field_name");

-- CreateIndex
CREATE INDEX "questions_status_created_at_idx" ON "questions"("status", "created_at");

-- CreateIndex
CREATE INDEX "questions_chapter_id_topic_id_subtopic_id_idx" ON "questions"("chapter_id", "topic_id", "subtopic_id");

-- CreateIndex
CREATE INDEX "answers_question_id_review_status_idx" ON "answers"("question_id", "review_status");

-- CreateIndex
CREATE INDEX "answers_candidate_id_idx" ON "answers"("candidate_id");

-- CreateIndex
CREATE INDEX "duplicate_matches_candidate_id_conflict_idx" ON "duplicate_matches"("candidate_id", "conflict");

-- CreateIndex
CREATE INDEX "duplicate_matches_question_id_idx" ON "duplicate_matches"("question_id");

-- CreateIndex
CREATE INDEX "provider_run_costs_workflow_run_id_operation_idx" ON "provider_run_costs"("workflow_run_id", "operation");

-- CreateIndex
CREATE INDEX "generated_papers_status_created_at_idx" ON "generated_papers"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "generated_paper_items_generated_paper_id_position_key" ON "generated_paper_items"("generated_paper_id", "position");

-- AddForeignKey
ALTER TABLE "source_papers" ADD CONSTRAINT "source_papers_upload_object_id_fkey" FOREIGN KEY ("upload_object_id") REFERENCES "upload_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "source_papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_start_outbox" ADD CONSTRAINT "workflow_start_outbox_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_pages" ADD CONSTRAINT "ocr_pages_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "source_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_blocks" ADD CONSTRAINT "ocr_blocks_ocr_page_id_fkey" FOREIGN KEY ("ocr_page_id") REFERENCES "ocr_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtopics" ADD CONSTRAINT "subtopics_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_candidates" ADD CONSTRAINT "question_candidates_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "source_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_candidates" ADD CONSTRAINT "question_candidates_approved_question_id_fkey" FOREIGN KEY ("approved_question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_candidates" ADD CONSTRAINT "question_candidates_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_candidates" ADD CONSTRAINT "question_candidates_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_candidates" ADD CONSTRAINT "question_candidates_subtopic_id_fkey" FOREIGN KEY ("subtopic_id") REFERENCES "subtopics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_field_confidences" ADD CONSTRAINT "candidate_field_confidences_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "question_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "question_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_source_paper_id_fkey" FOREIGN KEY ("source_paper_id") REFERENCES "source_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_corrections" ADD CONSTRAINT "review_corrections_review_item_id_fkey" FOREIGN KEY ("review_item_id") REFERENCES "review_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_subtopic_id_fkey" FOREIGN KEY ("subtopic_id") REFERENCES "subtopics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "question_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "question_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_run_costs" ADD CONSTRAINT "provider_run_costs_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_paper_items" ADD CONSTRAINT "generated_paper_items_generated_paper_id_fkey" FOREIGN KEY ("generated_paper_id") REFERENCES "generated_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_paper_items" ADD CONSTRAINT "generated_paper_items_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

