CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "locked_until" TIMESTAMPTZ(3) NOT NULL,
    "locked_by" TEXT,
    "last_run_at" TIMESTAMPTZ(3),
    "last_result" JSONB,
    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);
