// Node tests for scripts/gen-wrangler-config.mjs (Vitest runs in workerd and cannot load these scripts):
// `npm run test:scripts`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildConfig, PREBUILT_MAIN, stripJsonComments } from "../gen-wrangler-config.mjs";

const template = readFileSync(new URL("../../wrangler.example.jsonc", import.meta.url), "utf8");
const env = {
	KITTING_DOMAIN: "https://kitting.yourco.example/",
	D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
	TEAM_DOMAIN: "yourco.cloudflareaccess.com",
	ACCESS_AUD: "aud-tag",
	ADMIN_EMAILS: "admin@yourco.example",
};

test("strips comments but not slashes inside strings", () => {
	assert.deepEqual(JSON.parse(stripJsonComments('{ "a": "http://x" /* c */, // d\n "b": 1 }')), {
		a: "http://x",
		b: 1,
	});
});

test("source mode keeps the build step and the source entry point", () => {
	const config = buildConfig(template, env);
	assert.equal(config.main, "src/index.ts");
	assert.ok(config.build);
	assert.equal(config.no_bundle, undefined);
});

test("prebuilt mode uploads the built Worker as is", () => {
	const config = buildConfig(template, env, { prebuilt: true });
	assert.equal(config.main, PREBUILT_MAIN);
	assert.equal(config.no_bundle, true);
	assert.equal(config.build, undefined);
	assert.equal(config.$schema, undefined);
	assert.equal(config.assets.directory, "./public");
	assert.equal(config.d1_databases[0].migrations_dir, "migrations");
});

for (const prebuilt of [false, true]) {
	test(`production settings are forced (prebuilt: ${prebuilt})`, () => {
		const hostile = { ...env, DEV_AUTH_EMAIL: "dev@yourco.example", ENVIRONMENT: "development" };
		const config = buildConfig(template, hostile, { prebuilt });
		assert.equal(config.workers_dev, false);
		assert.equal(config.preview_urls, false);
		assert.deepEqual(config.routes, [{ pattern: "kitting.yourco.example", custom_domain: true }]);
		assert.equal(config.vars.ENVIRONMENT, "production");
		assert.equal(config.vars.DEV_AUTH_EMAIL, "");
		assert.equal(config.vars.TEAM_DOMAIN, "yourco.cloudflareaccess.com");
		assert.equal(config.d1_databases[0].database_id, env.D1_DATABASE_ID);
	});
}

test("photos and MCP bindings exist only when configured", () => {
	const without = buildConfig(template, env, { prebuilt: true });
	assert.equal(without.r2_buckets, undefined);
	assert.equal(without.kv_namespaces, undefined);
	const kv = "0123456789abcdef0123456789abcdef";
	const withBoth = buildConfig(template, { ...env, IMAGES_BUCKET: "photos", OAUTH_KV_ID: kv }, { prebuilt: true });
	assert.deepEqual(withBoth.r2_buckets, [{ binding: "IMAGES", bucket_name: "photos" }]);
	assert.deepEqual(withBoth.kv_namespaces, [{ binding: "OAUTH_KV", id: kv }]);
});

test("refuses missing or unsafe settings", () => {
	assert.throws(() => buildConfig(template, { ...env, ACCESS_AUD: " " }), /ACCESS_AUD/);
	assert.throws(() => buildConfig(template, { ...env, KITTING_DOMAIN: "kitting.yourco.workers.dev" }), /workers\.dev/);
	assert.throws(() => buildConfig(template, { ...env, DEFAULT_LOCALE: "de" }), /DEFAULT_LOCALE/);
	assert.throws(() => buildConfig(template, { ...env, OAUTH_KV_ID: "nope" }), /OAUTH_KV_ID/);
});
