CREATE TYPE "public"."cell_execution_state" AS ENUM('sent', 'running', 'ok', 'error', 'aborted', 'incomplete', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."file_transfer_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."file_transfer_state" AS ENUM('started', 'done', 'failed', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."notebook_session_state" AS ENUM('starting', 'ready', 'disconnected', 'unconfirmed', 'stopping', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."working_copy_source" AS ENUM('browser', 'import', 'server');--> statement-breakpoint
CREATE TABLE "cell_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_ref" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"cell_id" text NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"working_copy_revision" integer,
	"code_hash" "bytea" NOT NULL,
	"kernel_id" text NOT NULL,
	"kernel_generation" integer NOT NULL,
	"msg_id" uuid NOT NULL,
	"state" "cell_execution_state" NOT NULL,
	"execution_count" integer,
	"outputs_incomplete" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "cell_executions_msgId_unique" UNIQUE("msg_id"),
	CONSTRAINT "cell_executions_sessionId_clientRef_unique" UNIQUE("session_id","client_ref"),
	CONSTRAINT "cell_executions_sessionId_seq_unique" UNIQUE("session_id","seq"),
	CONSTRAINT "cell_executions_code_hash" CHECK (octet_length("cell_executions"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "file_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" "file_transfer_direction" NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"state" "file_transfer_state" NOT NULL,
	"object_key" text,
	"conflict" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notebook_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"working_copy_id" uuid,
	"state" "notebook_session_state" NOT NULL,
	"cause" text,
	"owned" boolean NOT NULL,
	"runtime" jsonb NOT NULL,
	"environment" jsonb,
	"jupyter_version" text,
	"lease" jsonb NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"kernel_id" text,
	"kernel_name" text,
	"kernel_generation" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "notebook_sessions_stopped_at" CHECK (("notebook_sessions"."state" in ('stopped', 'failed')) = ("notebook_sessions"."stopped_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "notebook_submission_files" (
	"submission_id" uuid NOT NULL,
	"path" text NOT NULL,
	"class_id" uuid NOT NULL,
	"file_transfer_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"object_key" text NOT NULL,
	CONSTRAINT "notebook_submission_files_submission_id_path_pk" PRIMARY KEY("submission_id","path")
);
--> statement-breakpoint
CREATE TABLE "notebook_working_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notebook_working_copies_userId_classId_sourceRevisionId_unique" UNIQUE("user_id","class_id","source_revision_id"),
	CONSTRAINT "notebook_working_copies_revision" CHECK ("notebook_working_copies"."current_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "notebook_working_copy_revisions" (
	"working_copy_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"class_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"source" "working_copy_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notebook_working_copy_revisions_working_copy_id_revision_pk" PRIMARY KEY("working_copy_id","revision"),
	CONSTRAINT "notebook_working_copy_revisions_revision" CHECK ("notebook_working_copy_revisions"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD COLUMN "working_copy_id" uuid;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD COLUMN "working_copy_revision" integer;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "cell_executions" ADD CONSTRAINT "cell_executions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_executions" ADD CONSTRAINT "cell_executions_session_id_notebook_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."notebook_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_executions" ADD CONSTRAINT "cell_executions_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_session_id_notebook_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."notebook_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_connection_id_notebook_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."notebook_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_sessions" ADD CONSTRAINT "notebook_sessions_working_copy_id_notebook_working_copies_id_fk" FOREIGN KEY ("working_copy_id") REFERENCES "public"."notebook_working_copies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submission_files" ADD CONSTRAINT "notebook_submission_files_submission_id_notebook_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."notebook_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submission_files" ADD CONSTRAINT "notebook_submission_files_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submission_files" ADD CONSTRAINT "notebook_submission_files_file_transfer_id_file_transfers_id_fk" FOREIGN KEY ("file_transfer_id") REFERENCES "public"."file_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_working_copies" ADD CONSTRAINT "notebook_working_copies_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_working_copies" ADD CONSTRAINT "notebook_working_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_working_copies" ADD CONSTRAINT "notebook_working_copies_source_revision_id_resource_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_working_copy_revisions" ADD CONSTRAINT "notebook_working_copy_revisions_working_copy_id_notebook_working_copies_id_fk" FOREIGN KEY ("working_copy_id") REFERENCES "public"."notebook_working_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_working_copy_revisions" ADD CONSTRAINT "notebook_working_copy_revisions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cell_executions_class_id_index" ON "cell_executions" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "file_transfers_class_id_index" ON "file_transfers" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "file_transfers_session_id_index" ON "file_transfers" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notebook_sessions_open_key" ON "notebook_sessions" USING btree ("user_id","class_id","resource_revision_id") WHERE "notebook_sessions"."state" not in ('stopped', 'failed');--> statement-breakpoint
CREATE INDEX "notebook_sessions_connector_open_idx" ON "notebook_sessions" USING btree ("connector_id") WHERE "notebook_sessions"."state" not in ('stopped', 'failed');--> statement-breakpoint
CREATE INDEX "notebook_sessions_class_id_user_id_index" ON "notebook_sessions" USING btree ("class_id","user_id");--> statement-breakpoint
CREATE INDEX "notebook_submission_files_class_id_index" ON "notebook_submission_files" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "notebook_working_copy_revisions_class_id_index" ON "notebook_working_copy_revisions" USING btree ("class_id");--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_working_copy_id_notebook_working_copies_id_fk" FOREIGN KEY ("working_copy_id") REFERENCES "public"."notebook_working_copies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_session_id_notebook_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."notebook_sessions"("id") ON DELETE no action ON UPDATE no action;