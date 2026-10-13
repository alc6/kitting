// Node tests for scripts/deploy-release.mjs: `npm run test:scripts`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	mergeSettings,
	parseArgs,
	parseSettings,
	planSteps,
	readBundle,
	wranglerVersion,
	writeConfig,
} from "../deploy-release.mjs";

const repo = join(fileURLToPath(import.meta.url), "..", "..", "..");
const settings = {
	KITTING_DOMAIN: "kitting.yourco.example",
	D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
	TEAM_DOMAIN: "yourco.cloudflareaccess.com",
	ACCESS_AUD: "aud-tag",
	ADMIN_EMAILS: "admin@yourco.example",
};

/** A minimal extracted bundle in a temporary folder. */
function fakeBundle() {
	const dir = mkdtempSync(join(tmpdir(), "kitting-bundle-"));
	mkdirSync(join(dir, "worker"));
	writeFileSync(join(dir, "worker", "index.js"), "export default {};\n");
	mkdirSync(join(dir, "public"));
	mkdirSync(join(dir, "migrations"));
	writeFileSync(join(dir, "migrations", "0000_init.sql"), "SELECT 1;\n");
	cpSync(join(repo, "wrangler.example.jsonc"), join(dir, "wrangler.example.jsonc"));
	writeFileSync(
		join(dir, "release.json"),
		JSON.stringify({ name: "kitting", version: "9.9.9", wrangler: "4.149.0", main: "worker/index.js" }),
	);
	return dir;
}

test("parses arguments", () => {
	assert.deepEqual(parseArgs([]), { bundle: null, dryRun: false, skipMigrations: false, settings: null });
	assert.deepEqual(parseArgs(["out", "--dry-run", "--skip-migrations", "--settings", "s.json"]), {
		bundle: "out",
		dryRun: true,
		skipMigrations: true,
		settings: "s.json",
	});
	assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
	assert.throws(() => parseArgs(["a", "b"]), /Unexpected argument/);
	assert.throws(() => parseArgs(["--settings"]), /--settings needs/);
});

test("the settings file supplies defaults and the environment wins", () => {
	const file = parseSettings(JSON.stringify({ ...settings, IMAGES_BUCKET: null, CURRENCY: "USD" }));
	assert.equal(file.IMAGES_BUCKET, undefined);
	const merged = mergeSettings(file, { CURRENCY: "GBP", ACCESS_AUD: "", PATH: "/bin" });
	assert.equal(merged.CURRENCY, "GBP");
	assert.equal(merged.ACCESS_AUD, "aud-tag");
	assert.equal(merged.PATH, undefined);
	assert.throws(() => parseSettings("[]"), /JSON object/);
	assert.throws(() => parseSettings("{"), /not valid JSON/);
	assert.throws(() => parseSettings('{"CLOUDFLARE_API_TOKEN":"x"}'), /Unknown setting/);
	assert.throws(() => parseSettings('{"CURRENCY":1}'), /must be a string/);
});

test("runs the migrations before the deploy, and only the deploy in a dry run", () => {
	assert.deepEqual(planSteps({ dryRun: false, skipMigrations: false }), [
		["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.jsonc"],
		["deploy", "--config", "wrangler.jsonc"],
	]);
	assert.deepEqual(planSteps({ dryRun: true, skipMigrations: false }), [
		["deploy", "--config", "wrangler.jsonc", "--dry-run"],
	]);
	assert.deepEqual(planSteps({ dryRun: false, skipMigrations: true }), [["deploy", "--config", "wrangler.jsonc"]]);
});

test("checks the bundle", () => {
	const dir = fakeBundle();
	try {
		assert.equal(readBundle(dir).version, "9.9.9");
		rmSync(join(dir, "migrations", "0000_init.sql"));
		assert.throws(() => readBundle(dir), /no migration/);
		rmSync(join(dir, "public"), { recursive: true });
		assert.throws(() => readBundle(dir), /public is missing/);
		assert.throws(() => readBundle(tmpdir()), /not an extracted/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pins wrangler from release.json unless overridden", () => {
	assert.equal(wranglerVersion({ wrangler: "4.149.0" }, {}), "4.149.0");
	assert.equal(wranglerVersion({ wrangler: "4.149.0" }, { WRANGLER_VERSION: "4.150.0" }), "4.150.0");
	assert.throws(() => wranglerVersion({ wrangler: "latest" }, {}), /Invalid wrangler version/);
	assert.throws(() => wranglerVersion({}, {}), /Invalid wrangler version/);
});

test("writes a production wrangler.jsonc for the prebuilt Worker", () => {
	const dir = fakeBundle();
	try {
		writeConfig(dir, { ...settings, IMAGES_BUCKET: "photos" });
		const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
		const config = JSON.parse(text.replace(/^\/\/.*\n/, ""));
		assert.equal(config.main, "worker/index.js");
		assert.equal(config.no_bundle, true);
		assert.equal(config.build, undefined);
		assert.equal(config.workers_dev, false);
		assert.equal(config.preview_urls, false);
		assert.equal(config.vars.ENVIRONMENT, "production");
		assert.equal(config.vars.DEV_AUTH_EMAIL, "");
		assert.equal(config.r2_buckets[0].bucket_name, "photos");
		assert.throws(() => writeConfig(dir, {}), /Missing required variables/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the command refuses to deploy without settings or credentials, before running wrangler", () => {
	const dir = fakeBundle();
	const script = join(repo, "scripts", "deploy-release.mjs");
	const env = { PATH: process.env.PATH };
	try {
		const noSettings = spawnSync(process.execPath, [script, dir, "--dry-run"], { env, encoding: "utf8" });
		assert.equal(noSettings.status, 1);
		assert.match(noSettings.stderr, /Missing required variables/);
		const noToken = spawnSync(process.execPath, [script, dir], { env: { ...env, ...settings }, encoding: "utf8" });
		assert.equal(noToken.status, 1);
		assert.match(noToken.stderr, /CLOUDFLARE_API_TOKEN is not set/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
