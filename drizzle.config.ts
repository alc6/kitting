import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into migrations/; `wrangler d1 migrations apply` applies them.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/schema.ts",
	out: "./migrations",
});
