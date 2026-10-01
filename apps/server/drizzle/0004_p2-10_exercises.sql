CREATE TYPE "public"."exercise_event_kind" AS ENUM('check', 'hint_shown', 'solution_revealed', 'step_completed', 'restart');--> statement-breakpoint
CREATE TYPE "public"."exercise_help" AS ENUM('independent', 'with_hints', 'solution_shown');--> statement-breakpoint
CREATE TABLE "exercise_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"seed" integer NOT NULL,
	"completion" "exercise_help",
	"completed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_attempts_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "exercise_attempts_classId_userId_resourceId_number_unique" UNIQUE("class_id","user_id","resource_id","number"),
	CONSTRAINT "exercise_attempts_completion" CHECK (("exercise_attempts"."completion" is null) = ("exercise_attempts"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "exercise_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"step_id" text,
	"kind" "exercise_event_kind" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_events_attemptId_seq_unique" UNIQUE("attempt_id","seq"),
	CONSTRAINT "exercise_events_step" CHECK (("exercise_events"."kind" = 'restart') = ("exercise_events"."step_id" is null))
);
--> statement-breakpoint
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_events" ADD CONSTRAINT "exercise_events_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_events" ADD CONSTRAINT "exercise_events_attempt_fk" FOREIGN KEY ("attempt_id","class_id") REFERENCES "public"."exercise_attempts"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_attempts_current" ON "exercise_attempts" USING btree ("class_id","user_id","resource_id") WHERE "exercise_attempts"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "exercise_attempts_class_id_resource_id_index" ON "exercise_attempts" USING btree ("class_id","resource_id");--> statement-breakpoint
-- Hand-written (§9, A23): exercise events are append-only. Updates and direct deletes are
-- rejected; deletes cascading from an attempt, class or account (trigger depth > 1) proceed.
CREATE FUNCTION "public"."reject_exercise_event_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on exercise_events rejected: attempt evidence is append-only', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "exercise_events_append_only" BEFORE UPDATE OR DELETE ON "exercise_events" FOR EACH ROW EXECUTE FUNCTION "public"."reject_exercise_event_change"();
