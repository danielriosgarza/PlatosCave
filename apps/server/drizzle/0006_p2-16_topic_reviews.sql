CREATE TABLE "topic_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_preview" boolean DEFAULT false NOT NULL,
	"topic_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_reviews_classId_userId_resourceId_unique" UNIQUE("class_id","user_id","resource_id")
);
--> statement-breakpoint
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_reviews_class_id_user_id_index" ON "topic_reviews" USING btree ("class_id","user_id");