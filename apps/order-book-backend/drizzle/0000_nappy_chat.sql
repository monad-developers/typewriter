CREATE TYPE "public"."mutation_status" AS ENUM('accepted', 'proposed', 'voted', 'finalized', 'verified');--> statement-breakpoint
CREATE TABLE "accounts" (
	"address" char(42) PRIMARY KEY NOT NULL,
	"nonce" numeric(78, 0) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "add_instruments" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"instrument_id" bigint NOT NULL,
	"base" char(42) NOT NULL,
	"quote" char(42) NOT NULL,
	"base_lot_exp" integer NOT NULL,
	"quote_lot_exp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"account" char(42) NOT NULL,
	"asset" char(42) NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	CONSTRAINT "balances_account_asset_pk" PRIMARY KEY("account","asset")
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"number" numeric(78, 0) PRIMARY KEY NOT NULL,
	"hash" char(66) NOT NULL,
	"timestamp" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"block_number" numeric(78, 0),
	"transaction_hash" char(66)
);
--> statement-breakpoint
CREATE TABLE "close_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"account" char(42) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"order_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"account" char(42) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"asset" char(42) NOT NULL,
	"amount" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"market_order_id" integer NOT NULL,
	"fill_index" smallint NOT NULL,
	"quantity" bigint NOT NULL,
	"price" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"base" char(42) NOT NULL,
	"base_lot_exp" integer NOT NULL,
	"quote" char(42) NOT NULL,
	"quote_lot_exp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limit_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"account" char(42) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"quantity" bigint NOT NULL,
	"instrument_id" bigint NOT NULL,
	"price" bigint NOT NULL,
	"bid_or_ask" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"account" char(42) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"quantity" bigint NOT NULL,
	"min_received_quantity" bigint NOT NULL,
	"instrument_id" bigint NOT NULL,
	"bid_or_ask" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_index" bigint NOT NULL,
	"account" char(42) NOT NULL,
	"quantity" bigint NOT NULL,
	"instrument_id" bigint NOT NULL,
	"price" bigint NOT NULL,
	"tick_volume" bigint NOT NULL,
	"side" smallint NOT NULL,
	CONSTRAINT "orders_account_order_index_pk" PRIMARY KEY("account","order_index")
);
--> statement-breakpoint
CREATE TABLE "ticks" (
	"instrument_id" bigint NOT NULL,
	"side" smallint NOT NULL,
	"price" bigint NOT NULL,
	"quantity" bigint NOT NULL,
	"remaining_quantity" bigint NOT NULL,
	"volume" bigint NOT NULL,
	CONSTRAINT "ticks_instrument_id_side_price_pk" PRIMARY KEY("instrument_id","side","price")
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer,
	"status" "mutation_status" NOT NULL,
	"account" char(42) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"deadline" numeric(78, 0) NOT NULL,
	"signature" text NOT NULL,
	"asset" char(42) NOT NULL,
	"amount" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "add_instruments" ADD CONSTRAINT "add_instruments_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_accounts_address_fk" FOREIGN KEY ("account") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "public"."blocks"("number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_orders" ADD CONSTRAINT "close_orders_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_market_order_id_market_orders_id_fk" FOREIGN KEY ("market_order_id") REFERENCES "public"."market_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_orders" ADD CONSTRAINT "limit_orders_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_accounts_address_fk" FOREIGN KEY ("account") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticks" ADD CONSTRAINT "ticks_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "add_instruments_bundle_id_index" ON "add_instruments" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "close_orders_account_index" ON "close_orders" USING btree ("account");--> statement-breakpoint
CREATE INDEX "close_orders_bundle_id_index" ON "close_orders" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "deposits_account_index" ON "deposits" USING btree ("account");--> statement-breakpoint
CREATE INDEX "deposits_bundle_id_index" ON "deposits" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "fills_market_order_id_index" ON "fills" USING btree ("market_order_id");--> statement-breakpoint
CREATE INDEX "limit_orders_account_index" ON "limit_orders" USING btree ("account");--> statement-breakpoint
CREATE INDEX "limit_orders_instrument_id_index" ON "limit_orders" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "limit_orders_bundle_id_index" ON "limit_orders" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "market_orders_account_index" ON "market_orders" USING btree ("account");--> statement-breakpoint
CREATE INDEX "market_orders_instrument_id_index" ON "market_orders" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "market_orders_bundle_id_index" ON "market_orders" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "withdrawals_account_index" ON "withdrawals" USING btree ("account");--> statement-breakpoint
CREATE INDEX "withdrawals_bundle_id_index" ON "withdrawals" USING btree ("bundle_id");