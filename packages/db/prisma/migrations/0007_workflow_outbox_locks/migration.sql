ALTER TYPE "OutboxStatus" ADD VALUE 'DISPATCHING';

ALTER TABLE "workflow_start_outbox" ADD COLUMN "locked_at" TIMESTAMP(3);
