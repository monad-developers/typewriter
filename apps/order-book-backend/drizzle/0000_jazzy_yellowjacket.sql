CREATE TABLE "deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"schema_name" text NOT NULL,
	"contract_address" char(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_schemaName_unique" UNIQUE("schema_name"),
	CONSTRAINT "deployments_contractAddress_chainId_unique" UNIQUE("contract_address","chain_id")
);
