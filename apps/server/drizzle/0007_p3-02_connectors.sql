CREATE TYPE "public"."compute_isolation" AS ENUM('account', 'container', 'allocation');--> statement-breakpoint
CREATE TYPE "public"."connector_mode" AS ENUM('personal', 'managed');--> statement-breakpoint
CREATE TYPE "public"."connector_revoked_reason" AS ENUM('user', 'unpair', 'account', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TABLE "class_compute_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"target" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"isolation" "compute_isolation" NOT NULL,
	"lease" jsonb,
	"host_owner_confirmed_by" uuid NOT NULL,
	"host_owner_confirmed_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"connector_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_pairings_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"mode" "connector_mode" NOT NULL,
	"status" "connector_status" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"version" text NOT NULL,
	"network_scope" jsonb DEFAULT '{"cidrs":[],"hosts":[]}'::jsonb NOT NULL,
	"approve_by" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "connector_revoked_reason",
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_fingerprint_unique" UNIQUE("fingerprint"),
	CONSTRAINT "connectors_owner_mode" CHECK (("connectors"."mode" = 'personal') = ("connectors"."owner_user_id" is not null)),
	CONSTRAINT "connectors_name_length" CHECK (char_length("connectors"."name") between 1 and 60),
	CONSTRAINT "connectors_public_key_length" CHECK (octet_length("connectors"."public_key") = 32),
	CONSTRAINT "connectors_pending" CHECK (("connectors"."status" = 'pending') = ("connectors"."approve_by" is not null)),
	CONSTRAINT "connectors_revoked" CHECK (("connectors"."status" = 'revoked') = ("connectors"."revoked_at" is not null)),
	CONSTRAINT "connectors_revoked_reason" CHECK (("connectors"."revoked_at" is null) = ("connectors"."revoked_reason" is null)),
	CONSTRAINT "connectors_approved" CHECK (("connectors"."status" <> 'active' or "connectors"."approved_at" is not null)
        and ("connectors"."status" <> 'pending' or "connectors"."approved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "notebook_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"template_id" uuid,
	"trusted_host_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "notebook_connections_name_length" CHECK (char_length("notebook_connections"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "class_compute_templates" ADD CONSTRAINT "class_compute_templates_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_compute_templates" ADD CONSTRAINT "class_compute_templates_host_owner_confirmed_by_users_id_fk" FOREIGN KEY ("host_owner_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_compute_templates" ADD CONSTRAINT "class_compute_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_pairings" ADD CONSTRAINT "connector_pairings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_pairings" ADD CONSTRAINT "connector_pairings_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_connections" ADD CONSTRAINT "notebook_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_connections" ADD CONSTRAINT "notebook_connections_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_connections" ADD CONSTRAINT "notebook_connections_template_id_class_compute_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."class_compute_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "class_compute_templates_class_id_index" ON "class_compute_templates" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "connector_pairings_owner_user_id_expires_at_index" ON "connector_pairings" USING btree ("owner_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "connectors_owner_user_id_status_index" ON "connectors" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notebook_connections_owner_name_key" ON "notebook_connections" USING btree ("owner_user_id",lower("name")) WHERE "notebook_connections"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "notebook_connections_connector_id_index" ON "notebook_connections" USING btree ("connector_id");