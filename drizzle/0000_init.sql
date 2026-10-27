CREATE TABLE IF NOT EXISTS "admin_user" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "combo" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"is_single" boolean DEFAULT false NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"limit_sets" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "combo_item" (
	"combo_id" integer NOT NULL,
	"zone_id" integer NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "combo_item_combo_id_zone_id_pk" PRIMARY KEY("combo_id","zone_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"show_at" timestamp with time zone NOT NULL,
	"vip_installed" boolean DEFAULT false NOT NULL,
	"sale_open" boolean DEFAULT false NOT NULL,
	"sale_start" timestamp with time zone,
	"sale_end" timestamp with time zone,
	"max_per_order" integer DEFAULT 6 NOT NULL,
	"hold_minutes" integer DEFAULT 20 NOT NULL,
	"pay_hours" integer DEFAULT 48 NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"bank_account" text DEFAULT '' NOT NULL,
	"account_name" text DEFAULT '' NOT NULL,
	"published" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_seat" (
	"event_id" integer NOT NULL,
	"seat_id" text NOT NULL,
	"zone_id" integer NOT NULL,
	"usage_id" integer NOT NULL,
	"status" text DEFAULT 'free' NOT NULL,
	"order_id" integer,
	"hold_until" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "event_seat_event_id_seat_id_pk" PRIMARY KEY("event_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invite_link" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"quota" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer,
	"link_id" integer,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_seat" (
	"order_id" integer NOT NULL,
	"seat_id" text NOT NULL,
	"unit_price" integer NOT NULL,
	"holder_name" text,
	"holder_id4" text,
	CONSTRAINT "order_seat_order_id_seat_id_pk" PRIMARY KEY("order_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_no" text,
	"event_id" integer NOT NULL,
	"link_id" integer NOT NULL,
	"combo_id" integer NOT NULL,
	"status" text NOT NULL,
	"amount" integer NOT NULL,
	"buyer_name" text,
	"buyer_phone" text,
	"buyer_email" text,
	"hold_until" timestamp with time zone,
	"pay_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"closed_reason" text,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"reported_last5" text NOT NULL,
	"reported_amount" integer NOT NULL,
	"reported_at" text NOT NULL,
	"confirmed_date" text,
	"confirmed_amount" integer,
	"confirmed_by" text,
	"note" text,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_zone" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"open" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seat_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sellable" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "venue_seat" (
	"id" text PRIMARY KEY NOT NULL,
	"section" text NOT NULL,
	"row_no" integer,
	"seat_no" text NOT NULL,
	"seat_type" text NOT NULL,
	"block" text NOT NULL,
	"code" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"entrance" text DEFAULT '2M 入口' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combo" ADD CONSTRAINT "combo_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combo_item" ADD CONSTRAINT "combo_item_combo_id_combo_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combo"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combo_item" ADD CONSTRAINT "combo_item_zone_id_price_zone_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."price_zone"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_seat" ADD CONSTRAINT "event_seat_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_seat" ADD CONSTRAINT "event_seat_seat_id_venue_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."venue_seat"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_seat" ADD CONSTRAINT "event_seat_zone_id_price_zone_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."price_zone"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_seat" ADD CONSTRAINT "event_seat_usage_id_seat_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."seat_usage"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_seat" ADD CONSTRAINT "order_seat_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_seat" ADD CONSTRAINT "order_seat_seat_id_venue_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."venue_seat"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_link_id_invite_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."invite_link"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_combo_id_combo_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combo"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_zone" ADD CONSTRAINT "price_zone_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seat_usage" ADD CONSTRAINT "seat_usage_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_user_username_idx" ON "admin_user" USING btree ("username");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_seat_order_idx" ON "event_seat" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invite_link_code_idx" ON "invite_link" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_no_idx" ON "orders" USING btree ("order_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_link_idx" ON "orders" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_order_idx" ON "payment" USING btree ("order_id");