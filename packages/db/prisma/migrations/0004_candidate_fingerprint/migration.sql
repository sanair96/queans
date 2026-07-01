ALTER TABLE "question_candidates" ADD COLUMN "fingerprint" TEXT;

UPDATE "question_candidates"
SET "fingerprint" = "id"
WHERE "fingerprint" IS NULL;

ALTER TABLE "question_candidates" ALTER COLUMN "fingerprint" SET NOT NULL;

CREATE UNIQUE INDEX "question_candidates_source_paper_id_fingerprint_key"
  ON "question_candidates"("source_paper_id", "fingerprint");
