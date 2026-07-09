-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "hubspot_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "assigned_to" TEXT,
    "score" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "hubspot_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "last_stage_change_at" TIMESTAMP(3),
    "followup_sent_at" TIMESTAMP(3),

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT,
    "category" TEXT,
    "validity_flag" TEXT,
    "response_draft" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_alerts" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "breached_at" TIMESTAMP(3) NOT NULL,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "sla_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_hubspot_id_key" ON "leads"("hubspot_id");

-- CreateIndex
CREATE UNIQUE INDEX "deals_hubspot_id_key" ON "deals"("hubspot_id");

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
