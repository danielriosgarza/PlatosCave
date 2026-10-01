CREATE TYPE "public"."resource_tab" AS ENUM('slides', 'reading', 'exercises', 'notebooks', 'tests');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('slides_pdf', 'slides_web', 'reading_native', 'reading_pdf', 'exercise', 'notebook', 'shiny', 'test');--> statement-breakpoint
CREATE TYPE "public"."resource_visibility" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TABLE "resource_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"type" "resource_type" NOT NULL,
	"content" jsonb NOT NULL,
	"object_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"derived" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accessible_alternative" jsonb,
	"provenance" jsonb,
	"content_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"type" "resource_type" NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"visibility" "resource_visibility" DEFAULT 'visible' NOT NULL,
	"release_at" timestamp with time zone,
	"head_revision_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_id_courseId_unique" UNIQUE("id","course_id")
);
--> statement-breakpoint
CREATE TABLE "study_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"tab" "resource_tab" NOT NULL,
	"position" jsonb NOT NULL,
	"layout" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_positions_userId_classId_resourceRevisionId_unique" UNIQUE("user_id","class_id","resource_revision_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"prerequisites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_rule" jsonb,
	"estimated_minutes" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_id_courseId_unique" UNIQUE("id","course_id")
);
--> statement-breakpoint
CREATE TABLE "class_release_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"from_release_id" uuid,
	"to_release_id" uuid NOT NULL,
	"actor_id" uuid,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"validation_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_releases_courseId_version_unique" UNIQUE("course_id","version"),
	CONSTRAINT "course_releases_id_courseId_unique" UNIQUE("id","course_id")
);
--> statement-breakpoint
CREATE TABLE "release_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"release_topic_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"tab" "resource_tab" NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"visibility" "resource_visibility" NOT NULL,
	"release_at" timestamp with time zone,
	CONSTRAINT "release_resources_releaseId_resourceId_unique" UNIQUE("release_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "release_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"prerequisites" jsonb NOT NULL,
	"completion_rule" jsonb,
	"estimated_minutes" integer,
	CONSTRAINT "release_topics_releaseId_topicId_unique" UNIQUE("release_id","topic_id"),
	CONSTRAINT "release_topics_id_releaseId_unique" UNIQUE("id","release_id")
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_objects_key_unique" UNIQUE("key"),
	CONSTRAINT "storage_objects_courseId_sha256_unique" UNIQUE("course_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "resource_revisions" ADD CONSTRAINT "resource_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_revisions" ADD CONSTRAINT "resource_revisions_resource_fk" FOREIGN KEY ("resource_id","course_id") REFERENCES "public"."resources"("id","course_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_head_revision_id_resource_revisions_id_fk" FOREIGN KEY ("head_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_topic_fk" FOREIGN KEY ("topic_id","course_id") REFERENCES "public"."topics"("id","course_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_positions" ADD CONSTRAINT "study_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_positions" ADD CONSTRAINT "study_positions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_positions" ADD CONSTRAINT "study_positions_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_release_history" ADD CONSTRAINT "class_release_history_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_release_history" ADD CONSTRAINT "class_release_history_from_release_id_course_releases_id_fk" FOREIGN KEY ("from_release_id") REFERENCES "public"."course_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_release_history" ADD CONSTRAINT "class_release_history_to_release_id_course_releases_id_fk" FOREIGN KEY ("to_release_id") REFERENCES "public"."course_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_release_history" ADD CONSTRAINT "class_release_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_releases" ADD CONSTRAINT "course_releases_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_releases" ADD CONSTRAINT "course_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_resources" ADD CONSTRAINT "release_resources_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_resources" ADD CONSTRAINT "release_resources_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_resources" ADD CONSTRAINT "release_resources_topic_fk" FOREIGN KEY ("release_topic_id","release_id") REFERENCES "public"."release_topics"("id","release_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_topics" ADD CONSTRAINT "release_topics_release_id_course_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."course_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_topics" ADD CONSTRAINT "release_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_revisions_resource_id_created_at_index" ON "resource_revisions" USING btree ("resource_id","created_at");--> statement-breakpoint
CREATE INDEX "resources_topic_id_position_index" ON "resources" USING btree ("topic_id","position");--> statement-breakpoint
CREATE INDEX "resources_course_id_index" ON "resources" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "study_positions_class_id_index" ON "study_positions" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "topics_course_id_position_index" ON "topics" USING btree ("course_id","position");--> statement-breakpoint
CREATE INDEX "class_release_history_class_id_created_at_index" ON "class_release_history" USING btree ("class_id","created_at");--> statement-breakpoint
CREATE INDEX "release_resources_resource_revision_id_index" ON "release_resources" USING btree ("resource_revision_id");--> statement-breakpoint
CREATE INDEX "storage_objects_course_id_index" ON "storage_objects" USING btree ("course_id");--> statement-breakpoint
-- Hand-written (ADR-0003): the adopted release must belong to the class's own course.
ALTER TABLE "classes" ADD CONSTRAINT "classes_release_fk" FOREIGN KEY ("release_id","course_id") REFERENCES "public"."course_releases"("id","course_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written (ADR-0003): published releases are immutable; any change means a new release.
CREATE FUNCTION "public"."reject_release_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % rejected: published releases are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "course_releases_immutable" BEFORE UPDATE OR DELETE ON "course_releases" FOR EACH ROW EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
CREATE TRIGGER "course_releases_no_truncate" BEFORE TRUNCATE ON "course_releases" FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
CREATE TRIGGER "release_topics_immutable" BEFORE UPDATE OR DELETE ON "release_topics" FOR EACH ROW EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
CREATE TRIGGER "release_topics_no_truncate" BEFORE TRUNCATE ON "release_topics" FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
CREATE TRIGGER "release_resources_immutable" BEFORE UPDATE OR DELETE ON "release_resources" FOR EACH ROW EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
CREATE TRIGGER "release_resources_no_truncate" BEFORE TRUNCATE ON "release_resources" FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_release_change"();--> statement-breakpoint
-- Hand-written (ADR-0003): a revision's content never changes; only conversion jobs write `derived`.
CREATE FUNCTION "public"."reject_revision_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'derived') IS DISTINCT FROM (to_jsonb(OLD) - 'derived') THEN
    RAISE EXCEPTION 'resource revision % is immutable except derived', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "resource_revisions_immutable" BEFORE UPDATE ON "resource_revisions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_revision_change"();
