import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.example.jsonc" },
				miniflare: {
					// The MCP server's OAuth store (optional in deployments, always present in tests; a test removes
					// it with { OAUTH_KV: undefined } to check the app without it).
					kvNamespaces: ["OAUTH_KV"],
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
		test: {
			setupFiles: ["./test/setup.ts"],
			// .claude/ holds local agent files, including git worktrees with their own copy of the tests.
			exclude: [...configDefaults.exclude, ".claude/**"],
		},
	};
});
