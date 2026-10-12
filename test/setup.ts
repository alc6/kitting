import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { resetDb } from "./helpers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared by the tests of a file: start every test from an empty database.
beforeEach(async () => {
	await resetDb();
});
