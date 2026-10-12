import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.example.jsonc" },
				miniflare: {
					// Every var is pinned so a local .dev.vars cannot change test results.
					bindings: {
						ENVIRONMENT: "development",
						DEV_AUTH_EMAIL: "tester@example.com",
						ADMIN_EMAILS: "tester@example.com",
						TEAM_DOMAIN: "kitting-test.cloudflareaccess.com",
						ACCESS_AUD: "test-aud",
						DEFAULT_LOCALE: "en",
						CURRENCY: "EUR",
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
		test: { setupFiles: ["./test/setup.ts"] },
	};
});
