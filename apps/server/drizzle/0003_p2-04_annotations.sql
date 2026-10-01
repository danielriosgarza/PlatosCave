CREATE TYPE "public"."annotation_kind" AS ENUM('highlight', 'note', 'sketch');--> statement-breakpoint
CREATE TYPE "public"."audience" AS ENUM('private', 'instructor', 'class');--> statement-breakpoint
CREATE TYPE "public"."placement_status" AS ENUM('mapped', 'needs_reattachment', 'manual');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "annotation_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"annotation_id" uuid,
	"thread_id" uuid,
	"resource_revision_id" uuid NOT NULL,
	"anchor" jsonb,
	"status" "placement_status" NOT NULL,
	"confidence" real,
	"placed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotation_placements_annotationId_resourceRevisionId_unique" UNIQUE("annotation_id","resource_revision_id"),
	CONSTRAINT "annotation_placements_threadId_resourceRevisionId_unique" UNIQUE("thread_id","resource_revision_id"),
	CONSTRAINT "annotation_placements_target" CHECK (num_nonnulls("annotation_placements"."annotation_id", "annotation_placements"."thread_id") = 1),
	CONSTRAINT "annotation_placements_anchor" CHECK (("annotation_placements"."status" = 'needs_reattachment') = ("annotation_placements"."anchor" is null))
);
--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"kind" "annotation_kind" NOT NULL,
	"audience" "audience" DEFAULT 'private' NOT NULL,
	"anchor" jsonb NOT NULL,
	"body" text,
	"color" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotations_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "annotations_private" CHECK ("annotations"."audience" = 'private')
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"parent_id" uuid,
	"body" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"moderated_at" timestamp with time zone,
	"moderated_by" uuid,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_id_threadId_unique" UNIQUE("id","thread_id"),
	CONSTRAINT "posts_body_or_tombstone" CHECK ("posts"."body" is not null or "posts"."deleted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_revision_id" uuid NOT NULL,
	"anchor" jsonb NOT NULL,
	"audience" "audience" NOT NULL,
	"status" "thread_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"source_annotation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_id_classId_unique" UNIQUE("id","class_id"),
	CONSTRAINT "threads_shared" CHECK ("threads"."audience" in ('instructor', 'class'))
);
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "students_edit_posts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "students_delete_posts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "annotation_placements" ADD CONSTRAINT "annotation_placements_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_placements" ADD CONSTRAINT "annotation_placements_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_placements" ADD CONSTRAINT "annotation_placements_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_placements" ADD CONSTRAINT "annotation_placements_annotation_fk" FOREIGN KEY ("annotation_id","class_id") REFERENCES "public"."annotations"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_placements" ADD CONSTRAINT "annotation_placements_thread_fk" FOREIGN KEY ("thread_id","class_id") REFERENCES "public"."threads"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_fk" FOREIGN KEY ("thread_id","class_id") REFERENCES "public"."threads"("id","class_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_fk" FOREIGN KEY ("parent_id","thread_id") REFERENCES "public"."posts"("id","thread_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_resource_revision_id_resource_revisions_id_fk" FOREIGN KEY ("resource_revision_id") REFERENCES "public"."resource_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_source_annotation_id_annotations_id_fk" FOREIGN KEY ("source_annotation_id") REFERENCES "public"."annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotation_placements_class_id_resource_revision_id_index" ON "annotation_placements" USING btree ("class_id","resource_revision_id");--> statement-breakpoint
CREATE INDEX "annotations_class_id_resource_id_author_id_index" ON "annotations" USING btree ("class_id","resource_id","author_id");--> statement-breakpoint
CREATE INDEX "posts_thread_id_created_at_index" ON "posts" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_class_id_resource_id_index" ON "threads" USING btree ("class_id","resource_id");--> statement-breakpoint
CREATE INDEX "threads_class_id_created_at_index" ON "threads" USING btree ("class_id","created_at");