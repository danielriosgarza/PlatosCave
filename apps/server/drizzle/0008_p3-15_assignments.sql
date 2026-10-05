CREATE TYPE "public"."test_attempt_state" AS ENUM('in_progress', 'submitted', 'grading', 'needs_review', 'graded', 'released');--> statement-breakpoint
CREATE TABLE "assignment_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"extra_attempts" integer DEFAULT 0 NOT NULL,
	"extra_minutes" integer DEFAULT 0 NOT NULL,
	"closes_at" timestamp with time zone,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_overrides_extra" CHECK ("assignment_overrides"."extra_attempts" >= 0 and "assignment_overrides"."extra_minutes" >= 0),
	CONSTRAINT "assignment_overrides_reason" CHECK (length(trim("assignment_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "assignments_classId_resourceId_unique" UNIQUE("class_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "attempt_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"value" jsonb,
	"flagged" boolean DEFAULT false NOT NULL,
	"seq" integer NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attempt_answers_attemptId_questionId_unique" UNIQUE("attempt_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "test_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"grader_version" text NOT NULL,
	"number" integer NOT NULL,
	"state" "test_attempt_state" DEFAULT 'in_progress' NOT NULL,
	"settings" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"local_copy" jsonb,
	"local_copy_at" timestamp with time zone,
	CONSTRAINT "test_attempts_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "test_attempts_classId_userId_resourceId_number_unique" UNIQUE("class_id","user_id","resource_id","number"),
	CONSTRAINT "test_attempts_submitted" CHECK (("test_attempts"."state" = 'in_progress') = ("test_attempts"."submitted_at" is null)),
	CONSTRAINT "test_attempts_number" CHECK ("test_attempts"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "test_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"submission_key" text,
	"answers" jsonb NOT NULL,
	"auto_submitted" boolean NOT NULL,
	"late" boolean NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "test_submissions_attemptId_unique" UNIQUE("attempt_id"),
	CONSTRAINT "test_submissions_classId_userId_submissionKey_unique" UNIQUE("class_id","user_id","submission_key"),
	CONSTRAINT "test_submissions_key" CHECK ("test_submissions"."auto_submitted" = ("test_submissions"."submission_key" is null))
);
--> statement-breakpoint
ALTER TABLE "assignment_overrides" ADD CONSTRAINT "assignment_overrides_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_overrides" ADD CONSTRAINT "assignment_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_overrides" ADD CONSTRAINT "assignment_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_overrides" ADD CONSTRAINT "assignment_overrides_assignment_fk" FOREIGN KEY ("assignment_id","class_id") REFERENCES "public"."assignments"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_assignment_fk" FOREIGN KEY ("assignment_id","class_id") REFERENCES "public"."assignments"("id","class_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_overrides_assignment_id_user_id_created_at_index" ON "assignment_overrides" USING btree ("assignment_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "test_attempts_open" ON "test_attempts" USING btree ("class_id","user_id","resource_id") WHERE "test_attempts"."state" = 'in_progress';--> statement-breakpoint
CREATE INDEX "test_attempts_class_id_resource_id_index" ON "test_attempts" USING btree ("class_id","resource_id");--> statement-breakpoint
-- Hand-written (§11, A14): a submitted snapshot is immutable, and overrides keep their history.
-- Updates and direct deletes are rejected; deletes cascading from an attempt, class or account
-- (trigger depth > 1) proceed.
CREATE FUNCTION "public"."reject_test_record_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % rejected: the record is immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "test_submissions_immutable" BEFORE UPDATE OR DELETE ON "test_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_test_record_change"();--> statement-breakpoint
CREATE TRIGGER "assignment_overrides_append_only" BEFORE UPDATE OR DELETE ON "assignment_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."reject_test_record_change"();--> statement-breakpoint
-- Hand-written (§11, A15): answers change only while their attempt is in progress, so what a
-- submission froze cannot move underneath it.
CREATE FUNCTION "public"."reject_closed_attempt_answer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "test_attempts" WHERE "id" = NEW."attempt_id" AND "state" = 'in_progress'
  ) THEN
    RAISE EXCEPTION '% on attempt_answers rejected: the attempt is closed', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "attempt_answers_open_only" BEFORE INSERT OR UPDATE ON "attempt_answers" FOR EACH ROW EXECUTE FUNCTION "public"."reject_closed_attempt_answer"();
