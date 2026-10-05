CREATE TYPE "public"."execution_check_set" AS ENUM('public', 'full');--> statement-breakpoint
CREATE TYPE "public"."execution_context" AS ENUM('attempt', 'preview');--> statement-breakpoint
CREATE TYPE "public"."execution_reason" AS ENUM('sample', 'grading', 'replay', 'regrade', 'preview');--> statement-breakpoint
CREATE TYPE "public"."execution_result_status" AS ENUM('passed', 'failed', 'time_limited', 'resource_exhausted');--> statement-breakpoint
CREATE TYPE "public"."execution_state" AS ENUM('queued', 'running', 'passed', 'failed', 'time_limited', 'resource_exhausted', 'cancelled', 'infrastructure_error');--> statement-breakpoint
CREATE TABLE "execution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_id" uuid,
	"question_revision_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"context" "execution_context" NOT NULL,
	"check_set" "execution_check_set" NOT NULL,
	"reason" "execution_reason" NOT NULL,
	"code_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"runtime_id" text NOT NULL,
	"image_ref" text NOT NULL,
	"harness_version" text NOT NULL,
	"grader_version" text NOT NULL,
	"limits" jsonb NOT NULL,
	"boss_job_id" uuid NOT NULL,
	"job_sent_at" timestamp with time zone,
	"state" "execution_state" DEFAULT 'queued' NOT NULL,
	"infrastructure_attempts" integer,
	"priority" integer NOT NULL,
	"failure" jsonb,
	"requested_by" uuid,
	"note" text,
	"superseded_by" uuid,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "execution_jobs_bossJobId_unique" UNIQUE("boss_job_id"),
	CONSTRAINT "execution_jobs_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "execution_jobs_context" CHECK (("execution_jobs"."context" = 'preview') = ("execution_jobs"."attempt_id" is null)),
	CONSTRAINT "execution_jobs_failure" CHECK (("execution_jobs"."state" = 'infrastructure_error') = ("execution_jobs"."failure" is not null))
);
--> statement-breakpoint
CREATE TABLE "execution_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_id" uuid,
	"question_revision_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"check_set" "execution_check_set" NOT NULL,
	"reason" "execution_reason" NOT NULL,
	"code_hash" text NOT NULL,
	"status" "execution_result_status" NOT NULL,
	"image_id" text NOT NULL,
	"image_digest" text,
	"harness_version" text NOT NULL,
	"grader_version" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_results_jobId_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_question_revision_id_resource_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_superseded_by_execution_jobs_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."execution_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_question_revision_id_resource_revisions_id_fk" FOREIGN KEY ("question_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_job_fk" FOREIGN KEY ("job_id","class_id") REFERENCES "public"."execution_jobs"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_jobs_user_id_state_index" ON "execution_jobs" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "execution_jobs_attempt_id_question_id_queued_at_index" ON "execution_jobs" USING btree ("attempt_id","question_id","queued_at");--> statement-breakpoint
CREATE INDEX "execution_jobs_class_id_index" ON "execution_jobs" USING btree ("class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_jobs_grading_once" ON "execution_jobs" USING btree ("attempt_id","question_id") WHERE "execution_jobs"."reason" = 'grading';--> statement-breakpoint
CREATE INDEX "execution_results_attempt_id_question_id_index" ON "execution_results" USING btree ("attempt_id","question_id");--> statement-breakpoint
CREATE INDEX "execution_results_attempt_id_question_id_code_hash_check_set_grader_version_index" ON "execution_results" USING btree ("attempt_id","question_id","code_hash","check_set","grader_version");--> statement-breakpoint
CREATE INDEX "execution_results_class_id_index" ON "execution_results" USING btree ("class_id");--> statement-breakpoint
-- Hand-written (docs/design/runner.md §8.3): a result is immutable. Updates and direct deletes
-- are rejected; deletes cascading from a run, attempt, class or account proceed.
CREATE TRIGGER "execution_results_immutable" BEFORE UPDATE OR DELETE ON "execution_results" FOR EACH ROW EXECUTE FUNCTION "public"."reject_test_record_change"();--> statement-breakpoint
-- Hand-written (design §8.3, §10.3): the runner's schema and role, the statements of
-- scripts/runner-role.sql with :app_role = the role this migration connects as, which is the
-- user of DATABASE_URL and the role that runs pg-boss. They run before pg-boss first creates its
-- tables in pgboss_exec, so those tables reach the runner through the default privileges. In
-- production operators run the script first under a role that may create roles; the IF NOT
-- EXISTS then skips the creation.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parallax_runner') THEN
    CREATE ROLE parallax_runner NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS pgboss_exec;--> statement-breakpoint
GRANT USAGE ON SCHEMA pgboss_exec TO parallax_runner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss_exec TO parallax_runner;--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pgboss_exec TO parallax_runner;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss_exec GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO parallax_runner',
    current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss_exec GRANT USAGE ON SEQUENCES TO parallax_runner',
    current_user);
END $$;--> statement-breakpoint
ALTER ROLE parallax_runner SET statement_timeout = '30s';
