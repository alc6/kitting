#!/usr/bin/env node
// Deploys an extracted release bundle (kitting-<version>.tar.gz, see scripts/build-release.mjs and D141) to Cloudflare
// with the installation's own settings, without the source code:
//
//   node scripts/deploy-release.mjs [bundle-dir] [--dry-run] [--skip-migrations] [--settings settings.json|-]
//
// 1. writes wrangler.jsonc in the bundle from the settings (same variables and same forced production settings as
//    scripts/gen-wrangler-config.mjs: ENVIRONMENT=production, empty DEV_AUTH_EMAIL, no workers.dev, no preview URLs);
// 2. applies the pending D1 migrations;
// 3. uploads the prebuilt Worker and the static files (wrangler never bundles or builds anything here).
// wrangler is run through npx at the version recorded in release.json (WRANGLER_VERSION overrides it), so the
// bundle needs no node_modules.
//
// Settings, as environment variables (a --settings JSON file of the same names supplies defaults; the environment
// wins). Required: KITTING_DOMAIN, D1_DATABASE_ID, TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS.
// Optional: WORKER_NAME, D1_DATABASE_NAME, DEFAULT_LOCALE, CURRENCY, IMAGES_BUCKET, OAUTH_KV_ID.
// Cloudflare credentials: CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID when the token sees several accounts).
// --dry-run generates the configuration and lets wrangler check the upload, but changes nothing in your account
// (no credentials needed, migrations are skipped).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, PREBUILT_MAIN } from "./gen-wrangler-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const SETTINGS = [
	"KITTING_DOMAIN",
	"D1_DATABASE_ID",
	"TEAM_DOMAIN",
	"ACCESS_AUD",
	"ADMIN_EMAILS",
	"WORKER_NAME",
	"D1_DATABASE_NAME",
	"DEFAULT_LOCALE",
	"CURRENCY",
	"IMAGES_BUCKET",
	"OAUTH_KV_ID",
];

export function parseArgs(argv) {
	const options = { bundle: null, dryRun: false, skipMigrations: false, settings: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--skip-migrations") options.skipMigrations = true;
		else if (arg === "--settings") {
			const value = argv[++i];
			if (!value) throw new Error("--settings needs a file name (or - for standard input)");
			options.settings = value;
		} else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
		else if (options.bundle) throw new Error(`Unexpected argument ${arg}`);
		else options.bundle = arg;
	}
	return options;
}

/** Settings from a JSON object of strings (the shape of the Terraform module's `deploy_env` output). */
export function parseSettings(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("The settings file is not valid JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error("The settings file must be a JSON object");
	const out = {};
	for (const [key, value] of Object.entries(data)) {
		if (!SETTINGS.includes(key)) throw new Error(`Unknown setting ${key} in the settings file`);
		if (value === null || value === undefined) continue;
		if (typeof value !== "string") throw new Error(`Setting ${key} must be a string`);
		out[key] = value;
	}
	return out;
}

/** The environment variables win over the settings file; an empty variable counts as unset. */
export function mergeSettings(fileSettings, env) {
	const merged = { ...fileSettings };
	for (const key of SETTINGS) if (env[key] !== undefined && env[key] !== "") merged[key] = env[key];
	return merged;
}

/** Checks that a folder is an extracted bundle and returns its release.json. */
export function readBundle(dir) {
	const manifest = join(dir, "release.json");
	if (!existsSync(manifest)) throw new Error(`${dir} is not an extracted Kitting release bundle (no release.json)`);
	const release = JSON.parse(readFileSync(manifest, "utf8"));
	if (release.main !== PREBUILT_MAIN) throw new Error(`Unexpected Worker path in release.json: ${release.main}`);
	for (const path of [PREBUILT_MAIN, "public", "migrations", "wrangler.example.jsonc"])
		if (!existsSync(join(dir, path))) throw new Error(`The bundle is incomplete: ${path} is missing`);
	if (!readdirSync(join(dir, "migrations")).some((f) => f.endsWith(".sql")))
		throw new Error("The bundle has no migration");
	return release;
}

export function wranglerVersion(release, env) {
	const version = (env.WRANGLER_VERSION || release.wrangler || "").trim();
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid wrangler version "${version}" (expected x.y.z)`);
	return version;
}

/** What to run, in order: wrangler arguments (after `wrangler@<version>`), all with the bundle as working directory. */
export function planSteps({ dryRun, skipMigrations }) {
	const steps = [];
	if (!dryRun && !skipMigrations)
		steps.push(["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.jsonc"]);
	steps.push(["deploy", "--config", "wrangler.jsonc", ...(dryRun ? ["--dry-run"] : [])]);
	return steps;
}

/** Writes wrangler.jsonc in the bundle and returns it. Throws on missing or invalid settings. */
export function writeConfig(dir, settings) {
	const template = readFileSync(join(dir, "wrangler.example.jsonc"), "utf8");
	const config = buildConfig(template, settings, { prebuilt: true });
	const header = "// Generated by scripts/deploy-release.mjs from the settings of this installation. Do not commit.\n";
	writeFileSync(join(dir, "wrangler.jsonc"), `${header}${JSON.stringify(config, null, 2)}\n`);
	return config;
}

function runWrangler(version, args, cwd, env) {
	const result = spawnSync("npx", ["--yes", `wrangler@${version}`, ...args], {
		cwd,
		env,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0)
		throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed (${result.status ?? result.signal})`);
}

export function deploy(argv, env) {
	const options = parseArgs(argv);
	const dir = resolve(options.bundle ?? join(here, ".."));
	const release = readBundle(dir);
	const version = wranglerVersion(release, env);
	let fileSettings = {};
	if (options.settings)
		fileSettings = parseSettings(readFileSync(options.settings === "-" ? 0 : options.settings, "utf8"));
	const settings = mergeSettings(fileSettings, env);
	if (!options.dryRun && !env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not set");

	const config = writeConfig(dir, settings);
	console.log(
		`Kitting ${release.version} -> ${config.routes[0].pattern} (worker "${config.name}", wrangler ${version})${options.dryRun ? " [dry run]" : ""}`,
	);
	for (const args of planSteps(options)) runWrangler(version, args, dir, env);
	console.log(options.dryRun ? "Dry run finished: nothing was changed." : `Kitting ${release.version} is deployed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		deploy(process.argv.slice(2), process.env);
	} catch (err) {
		console.error(`Cannot deploy: ${err.message}`);
		process.exit(1);
	}
}
