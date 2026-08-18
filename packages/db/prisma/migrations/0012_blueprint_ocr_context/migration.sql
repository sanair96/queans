CREATE TABLE "blueprint_ocr_blocks" (
  "id" TEXT NOT NULL,
  "blueprint_ocr_page_id" TEXT NOT NULL,
  "block_type" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  "bounding_box" JSONB,
  "source_asset" JSONB,
  "raw_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "blueprint_ocr_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blueprint_ocr_assets" (
  "id" TEXT NOT NULL,
  "blueprint_ocr_page_id" TEXT NOT NULL,
  "source_asset_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "bounding_box" JSONB,
  "raw_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "blueprint_ocr_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "blueprint_ocr_blocks_blueprint_ocr_page_id_block_type_idx"
  ON "blueprint_ocr_blocks"("blueprint_ocr_page_id", "block_type");

CREATE UNIQUE INDEX "blueprint_ocr_assets_blueprint_ocr_page_id_source_asset_id_key"
  ON "blueprint_ocr_assets"("blueprint_ocr_page_id", "source_asset_id");

CREATE INDEX "blueprint_ocr_assets_blueprint_ocr_page_id_idx"
  ON "blueprint_ocr_assets"("blueprint_ocr_page_id");

ALTER TABLE "blueprint_ocr_blocks"
  ADD CONSTRAINT "blueprint_ocr_blocks_blueprint_ocr_page_id_fkey"
  FOREIGN KEY ("blueprint_ocr_page_id") REFERENCES "blueprint_ocr_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blueprint_ocr_assets"
  ADD CONSTRAINT "blueprint_ocr_assets_blueprint_ocr_page_id_fkey"
  FOREIGN KEY ("blueprint_ocr_page_id") REFERENCES "blueprint_ocr_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
