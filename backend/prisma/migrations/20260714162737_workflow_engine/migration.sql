-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_type" TEXT NOT NULL,
    "trigger_payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'TRIAGED' CHECK (state in
      ('TRIAGED','PLANNED','AWAITING_APPROVAL','APPROVED','EXECUTING','DONE','REJECTED','FAILED','EXPIRED')),
    "plan" JSONB,
    "plan_summary" TEXT,
    "approved_by" TEXT,
    "notifier_message_ref" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK (status in
      ('pending','running','succeeded','failed','skipped')),
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "workflow_id" UUID,
    "actor" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_idempotency_key_key" ON "workflow_steps"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_workflow_id_step_index_key" ON "workflow_steps"("workflow_id", "step_index");

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
