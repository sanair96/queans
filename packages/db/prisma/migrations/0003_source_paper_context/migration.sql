ALTER TABLE "source_papers"
  ADD COLUMN "board" TEXT,
  ADD COLUMN "class_level" TEXT,
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "year" INTEGER,
  ADD COLUMN "school_name" TEXT,
  ADD COLUMN "exam_type" TEXT,
  ADD COLUMN "uploaded_by" TEXT,
  ADD COLUMN "metadata" JSONB;

CREATE INDEX "source_papers_board_class_level_subject_year_idx"
  ON "source_papers"("board", "class_level", "subject", "year");
