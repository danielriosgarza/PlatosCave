CREATE TABLE "notebook_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"submission_key" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"filename" text NOT NULL,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notebook_submissions_classId_userId_resourceId_version_unique" UNIQUE("class_id","user_id","resource_id","version"),
	CONSTRAINT "notebook_submissions_classId_userId_resourceId_submissionKey_unique" UNIQUE("class_id","user_id","resource_id","submission_key"),
	CONSTRAINT "notebook_submissions_version" CHECK ("notebook_submissions"."version" >= 1),
	CONSTRAINT "notebook_submissions_size" CHECK ("notebook_submissions"."size" > 0)
);
--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_submissions" ADD CONSTRAINT "notebook_submissions_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notebook_submissions_class_id_resource_id_index" ON "notebook_submissions" USING btree ("class_id","resource_id");--> statement-breakpoint
CREATE INDEX "signin_tokens_email_created_idx" ON "signin_tokens" USING btree ("email","created_at");--> statement-breakpoint
-- Hand-written (§10.5, A10): a submitted snapshot is immutable. Updates and direct deletes are
-- rejected; deletes cascading from a class or account (trigger depth > 1) proceed.
CREATE FUNCTION "public"."reject_notebook_submission_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on notebook_submissions rejected: a submitted snapshot is immutable', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "notebook_submissions_immutable" BEFORE UPDATE OR DELETE ON "notebook_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_notebook_submission_change"();
