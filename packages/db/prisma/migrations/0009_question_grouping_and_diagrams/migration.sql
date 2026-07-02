ALTER TABLE "question_candidates"
  ADD COLUMN "parent_question_number" TEXT,
  ADD COLUMN "question_label" TEXT,
  ADD COLUMN "part_label" TEXT,
  ADD COLUMN "group_key" TEXT,
  ADD COLUMN "stem_text" TEXT,
  ADD COLUMN "display_order" INTEGER;

ALTER TABLE "questions"
  ADD COLUMN "parent_question_number" TEXT,
  ADD COLUMN "question_label" TEXT,
  ADD COLUMN "part_label" TEXT,
  ADD COLUMN "group_key" TEXT,
  ADD COLUMN "stem_text" TEXT,
  ADD COLUMN "display_order" INTEGER,
  ADD COLUMN "requires_diagram" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "diagram_asset" JSONB;

CREATE INDEX "question_candidates_group_key_idx" ON "question_candidates"("source_paper_id", "group_key", "display_order");
CREATE INDEX "questions_group_key_idx" ON "questions"("group_key", "display_order");
