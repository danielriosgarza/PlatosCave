CREATE TYPE "public"."grade_source" AS ENUM('draft', 'regrade', 'override');--> statement-breakpoint
CREATE TYPE "public"."grade_state" AS ENUM('draft', 'released');--> statement-breakpoint
CREATE TABLE "grade_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"prior_grade_id" uuid NOT NULL,
	"points" double precision NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grade_overrides_reason" CHECK (length(trim("grade_overrides"."reason")) > 0),
	CONSTRAINT "grade_overrides_points" CHECK ("grade_overrides"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grade_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"released_by" uuid NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"recipients" jsonb NOT NULL,
	CONSTRAINT "grade_releases_id_classId_unique" UNIQUE("id","class_id")
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"grader_version" text NOT NULL,
	"number" integer NOT NULL,
	"state" "grade_state" DEFAULT 'draft' NOT NULL,
	"source" "grade_source" NOT NULL,
	"reason" text,
	"questions" jsonb NOT NULL,
	"feedback" jsonb NOT NULL,
	"automated_points" double precision NOT NULL,
	"manual_points" double precision NOT NULL,
	"override_id" uuid,
	"points" double precision NOT NULL,
	"possible" double precision NOT NULL,
	"complete" boolean NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"release_id" uuid,
	"released_at" timestamp with time zone,
	CONSTRAINT "grades_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "grades_attemptId_number_unique" UNIQUE("attempt_id","number"),
	CONSTRAINT "grades_released" CHECK (("grades"."state" = 'released') = ("grades"."release_id" is not null and "grades"."released_at" is not null)),
	CONSTRAINT "grades_reason" CHECK (("grades"."source" = 'draft') = ("grades"."reason" is null)),
	CONSTRAINT "grades_number" CHECK ("grades"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "test_attempts" ADD COLUMN "report_selected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_prior_fk" FOREIGN KEY ("prior_grade_id","class_id") REFERENCES "public"."grades"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_releases" ADD CONSTRAINT "grade_releases_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_releases" ADD CONSTRAINT "grade_releases_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_override_id_grade_overrides_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."grade_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."test_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_release_fk" FOREIGN KEY ("release_id","class_id") REFERENCES "public"."grade_releases"("id","class_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grade_releases_class_id_released_at_index" ON "grade_releases" USING btree ("class_id","released_at");--> statement-breakpoint
CREATE INDEX "grades_class_id_resource_id_index" ON "grades" USING btree ("class_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_attempts_report_selected" ON "test_attempts" USING btree ("class_id","user_id","resource_id") WHERE "test_attempts"."report_selected";--> statement-breakpoint
-- Hand-written (§11, §12, A17, A18): a grade row is never changed except by its release, which
-- sets the state, release and time and nothing else; it is never deleted except with its
-- attempt or class. Overrides and releases are append-only.
CREATE FUNCTION "public"."reject_grade_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" = 'draft' AND NEW."state" = 'released'
    AND (to_jsonb(NEW) - ARRAY['state', 'release_id', 'released_at'])
      = (to_jsonb(OLD) - ARRAY['state', 'release_id', 'released_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on grades rejected: a grade changes only by its release', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "grades_release_only" BEFORE UPDATE OR DELETE ON "grades" FOR EACH ROW EXECUTE FUNCTION "public"."reject_grade_change"();--> statement-breakpoint
CREATE TRIGGER "grade_overrides_append_only" BEFORE UPDATE OR DELETE ON "grade_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."reject_test_record_change"();--> statement-breakpoint
CREATE TRIGGER "grade_releases_append_only" BEFORE UPDATE OR DELETE ON "grade_releases" FOR EACH ROW EXECUTE FUNCTION "public"."reject_test_record_change"();
