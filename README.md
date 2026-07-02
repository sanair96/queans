# Queans

Question paper ingestion app with direct Cloudflare R2 uploads, Temporal-backed async processing, OCR/extraction, confidence gating, human review, and final question-bank ingestion.

## Architecture

The upload request is short-lived. The browser asks the API for a presigned R2 URL, uploads the paper directly to R2, then calls the API to mark the upload complete. That completion call creates a `source_papers` row, creates a `workflow_runs` row, writes a `workflow_start_outbox` row, and starts a Temporal workflow. If Temporal is temporarily unavailable, the durable outbox row can be dispatched again.

Workflow dispatch is claim-based: a dispatcher moves a retryable outbox row to `DISPATCHING` with a short `locked_at` lease before calling Temporal, then marks it `STARTED` after Temporal accepts the workflow. Stale dispatch leases are eligible for retry, so a crashed API process does not leave an upload permanently unprocessed.

The worker keeps large payloads in Postgres and R2. Temporal carries IDs and counts, while activities persist OCR pages, extracted candidates, confidence decisions, review items, final questions, answers, workflow steps, events, and provider cost metadata.

```mermaid
flowchart LR
  Browser["Web app"] --> ApiInit["POST /api/uploads/init"]
  ApiInit --> R2Put["Presigned R2 PUT"]
  Browser --> R2Put
  Browser --> ApiComplete["POST /api/uploads/:id/complete"]
  ApiComplete --> DbRows["upload_objects, source_papers, workflow_runs, workflow_start_outbox"]
  ApiComplete --> Temporal["Temporal workflow"]
  Temporal --> Ocr["Mistral OCR activity"]
  Ocr --> Pages["ocr_pages and ocr_blocks"]
  Temporal --> Extract["Mistral extraction activity"]
  Extract --> Candidates["question_candidates"]
  Temporal --> Confidence["confidence policy"]
  Confidence -->|high confidence| Questions["questions and answers"]
  Confidence -->|needs review| Review["review_items"]
  Review --> Reviewer["Human review UI"]
  Reviewer --> TemporalSignal["humanReviewCompleted signal"]
  TemporalSignal --> Questions
```

## Workspace

- `apps/web`: Next.js operator UI for upload, review queue, and approved questions.
- `apps/api`: Fastify API for upload sessions, workflow dispatch, ingestion status, review actions, and question reads.
- `apps/worker`: Temporal worker with ingestion workflow and activities.
- `packages/db`: Prisma schema and migrations for Postgres 18.
- `packages/core`: shared workflow constants, schemas, and confidence policy.
- `packages/providers`: R2, Mistral OCR, and Mistral extraction providers.

## Required Keys

Copy `.env.example` to `.env` and fill these before runtime testing:

- `INTERNAL_API_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `MISTRAL_API_KEY`

Use a long random value for `INTERNAL_API_TOKEN` outside local development. It is required for `POST /api/internal/dispatch-workflows` via the `x-queans-internal-token` header.

Leave `R2_ENDPOINT` empty for the standard Cloudflare R2 endpoint; the provider derives it from `R2_ACCOUNT_ID`, and it also normalizes the copied `<account-id>` placeholder to that derived endpoint. Set it only when using a custom S3-compatible endpoint. `R2_PRESIGN_EXPIRES_SECONDS` defaults to `900` and must stay between `1` and `604800`.

`MISTRAL_EXECUTION_MODE=sync` is the default local/pre-billing path. It uses the synchronous Mistral OCR and chat endpoints for OCR, segmentation, and solving so real question papers can be processed before provider batch billing is enabled. Set `MISTRAL_EXECUTION_MODE=batch` only after batch API access is available; batch mode preserves provider batch-job tracking and import retries.

Uploads are limited to supported OCR documents of 50 MB or smaller. The app currently accepts PDF, DOCX, PPTX, and ODT source files.

The API and worker load `.env` automatically in local development. The shared DB package resolves the workspace root `.env` before Prisma initializes, so package-scoped commands from `apps/api`, `apps/worker`, or `packages/db` use the same database URL. Shell-provided values still override `.env`, which is useful when running the Docker database on a non-default host port.

Provider pricing changes over time. The worker records `provider_run_costs.estimated_cost_usd` from these editable defaults:

- `MISTRAL_OCR_USD_PER_1000_PAGES=4`
- `MISTRAL_EXTRACTOR_INPUT_USD_PER_MILLION_TOKENS=0.15`
- `MISTRAL_EXTRACTOR_OUTPUT_USD_PER_MILLION_TOKENS=0.60`

`LLM_PROVIDER=mistral` is the only supported extractor provider today. Use `EXTRACTOR_MODEL` to choose the cheapest acceptable Mistral extraction model for your quality bar.

Optional Google Document AI benchmarking needs:

- `DOCUMENT_AI_ENABLED=true`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_DOCUMENT_AI_LOCATION`
- `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_DOCUMENT_AI_INPUT_BUCKET`
- `GOOGLE_DOCUMENT_AI_OUTPUT_BUCKET`

## Local Setup

Use pnpm through Corepack:

```bash
corepack enable
pnpm install
```

Start Docker Desktop or another Docker daemon, then start Postgres 18 and Temporal:

```bash
pnpm docker:up
```

If another local project already owns Postgres port `5432`, keep that process running and start Queans on alternate host ports:

```bash
POSTGRES_PORT=55432 TEMPORAL_POSTGRES_PORT=55433 pnpm docker:up
```

Generate the Prisma client and apply the migration:

```bash
pnpm db:generate
pnpm db:migrate
```

When using the alternate app database port, override the migration URL:

```bash
DATABASE_URL="postgresql://queans:queans@localhost:55432/queans_dev?schema=public" pnpm db:migrate
```

For production or production-like deploys, apply checked-in migrations without creating a development migration:

```bash
pnpm db:deploy
```

Run the app:

```bash
pnpm dev
```

Default URLs:

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- Temporal UI: `http://localhost:8233`

`GET /health` only checks that the API process is alive. `GET /ready` checks Postgres, Temporal, required R2/Mistral configuration, and the extractor provider setting; it will return `503` until the upload and OCR credentials are present.

## Ingestion Flow

1. `POST /api/uploads/init` creates a pending `upload_objects` row and returns a presigned R2 PUT URL.
2. The browser uploads the file directly to R2.
3. `POST /api/uploads/:id/complete` verifies the object size and content type, creates the source paper and ingestion run, and starts the workflow via the outbox.
4. Temporal runs OCR on the private R2 object using a short-lived signed read URL.
5. The extraction activity converts OCR pages into structured `question_candidates`.
6. The dedupe step compares candidates with approved bank questions and persists likely `duplicate_matches`.
7. The confidence policy auto-approves only source-backed, high-confidence candidates.
8. Ambiguous or conflicting candidates create `review_items` with reason codes and source evidence.
9. Human review updates the review item and signals the Temporal workflow.
10. Approved candidates are copied into `questions` and `answers`.

## Confidence Policy

The first pass is intentionally conservative:

- Required fields below `0.82` go to review.
- Optional fields below `0.72` can be approved with field review.
- OCR minimum confidence below `0.70` goes to review.
- OCR average confidence below `0.86` goes to review.
- Generated answers that are not source-validated always go to review.
- Duplicate conflicts, contradictions, math uncertainty, and diagram uncertainty go to review.

## Verification

Run the full local gate:

```bash
pnpm check
pnpm build
```

Runtime verification additionally needs Docker running, the migration applied, and real R2/Mistral credentials in `.env`.
