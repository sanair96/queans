ALTER TABLE "question_candidates"
  ADD COLUMN "answer_source_type" "AnswerSourceType" NOT NULL DEFAULT 'LLM_GENERATED',
  ADD COLUMN "answer_source_backed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "review_items"
  ADD COLUMN "applied_at" TIMESTAMP(3);

CREATE INDEX "review_items_source_paper_id_applied_at_idx" ON "review_items"("source_paper_id", "applied_at");
