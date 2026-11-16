CREATE TABLE "merch_colors" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_colors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"name" text NOT NULL,
	"hex" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merch_media" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"color_id" bigint,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"thumb" text,
	"width" integer,
	"height" integer,
	"bytes" integer NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merch_media_kind_ck" CHECK ("merch_media"."kind" in ('photo', 'model'))
);
--> statement-breakpoint
CREATE TABLE "merch_order_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"qty" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "merch_order_items_qty_ck" CHECK ("merch_order_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "merch_orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"code" text NOT NULL,
	"request_id" uuid,
	"status" text DEFAULT 'reserved' NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"payment_method" text,
	"expires_at" timestamp with time zone,
	"receipt_file" text,
	"receipt_mime" text,
	"receipt_at" timestamp with time zone,
	"note" text,
	"paid_at" timestamp with time zone,
	"paid_by" bigint,
	"issued_at" timestamp with time zone,
	"issued_by" bigint,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merch_orders_code_unique" UNIQUE("code"),
	CONSTRAINT "merch_orders_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "merch_orders_status_ck" CHECK ("merch_orders"."status" in ('reserved', 'paid', 'issued', 'cancelled', 'expired')),
	CONSTRAINT "merch_orders_method_ck" CHECK ("merch_orders"."payment_method" is null or "merch_orders"."payment_method" in ('cash', 'card', 'transfer'))
);
--> statement-breakpoint
CREATE TABLE "merch_products" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"subtitle" text,
	"description_md" text DEFAULT '' NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"badge" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merch_variants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "merch_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"color_id" bigint NOT NULL,
	"size" text NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "merch_variants_stock_ck" CHECK ("merch_variants"."stock" >= 0)
);
--> statement-breakpoint
ALTER TABLE "merch_colors" ADD CONSTRAINT "merch_colors_product_id_merch_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."merch_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_media" ADD CONSTRAINT "merch_media_product_id_merch_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."merch_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_media" ADD CONSTRAINT "merch_media_color_id_merch_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."merch_colors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_order_items" ADD CONSTRAINT "merch_order_items_order_id_merch_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merch_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_order_items" ADD CONSTRAINT "merch_order_items_variant_id_merch_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."merch_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_variants" ADD CONSTRAINT "merch_variants_color_id_merch_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."merch_colors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merch_colors_product_idx" ON "merch_colors" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "merch_media_product_idx" ON "merch_media" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "merch_order_items_order_idx" ON "merch_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "merch_order_items_variant_idx" ON "merch_order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "merch_orders_user_idx" ON "merch_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "merch_orders_status_idx" ON "merch_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "merch_variants_uq" ON "merch_variants" USING btree ("color_id","size");--> statement-breakpoint
-- Витрина и остатки обновляются в приложении сразу: любая правка каталога или заказов - событие «merch».
CREATE TRIGGER sof_merch_products_notify AFTER INSERT OR UPDATE OR DELETE ON merch_products
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('merch');--> statement-breakpoint
CREATE TRIGGER sof_merch_colors_notify AFTER INSERT OR UPDATE OR DELETE ON merch_colors
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('merch');--> statement-breakpoint
CREATE TRIGGER sof_merch_variants_notify AFTER INSERT OR UPDATE OR DELETE ON merch_variants
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('merch');--> statement-breakpoint
CREATE TRIGGER sof_merch_media_notify AFTER INSERT OR UPDATE OR DELETE ON merch_media
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('merch');--> statement-breakpoint
CREATE TRIGGER sof_merch_orders_notify AFTER INSERT OR UPDATE OR DELETE ON merch_orders
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('merch');
