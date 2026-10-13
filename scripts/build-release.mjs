#!/usr/bin/env node
// Builds the release bundle that installers deploy without the source code (D141):
//   npm run release:bundle   ->   dist/kitting-<version>.tar.gz (+ .sha256), dist/release/kitting-<version>/
// The bundle holds the Worker already built by wrangler (worker/index.js), the static assets with the stylesheet
// built (public/), the D1 migrations (migrations/*.sql), the config generator and the deploy script. It holds no
// setting of any installation: scripts/deploy-release.mjs adds those from environment variables.
// The archive is the same bytes on every run for the same inputs (fixed timestamps, sorted entries, our own
// tar writer so that it does not depend on the tar flavour of the machine).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** 2026-01-01T00:00:00Z, in seconds. */
const MTIME = 1767225600;

/** Every file under a directory, sorted, as paths relative to `base` with forward slashes. */
export function listFiles(dir, base = dir) {
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
		.map((p) => p.split(sep).join("/"));
}

function octal(value, length) {
	return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One ustar entry for a regular file: 512-byte header, then the data padded to a multiple of 512. */
export function tarEntry(path, data, mode = 0o644) {
	let name = path;
	let prefix = "";
	if (Buffer.byteLength(name) > 100) {
		// ustar splits a long path in a prefix (up to 155 bytes) and a name (up to 100) at a slash.
		const cut = name.lastIndexOf("/", 155);
		if (cut < 1 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Path too long for tar: ${path}`);
		prefix = name.slice(0, cut);
		name = name.slice(cut + 1);
	}
	const header = Buffer.alloc(512);
	header.write(name, 0, 100);
	header.write(octal(mode, 8), 100);
	header.write(octal(0, 8), 108); // uid
	header.write(octal(0, 8), 116); // gid
	header.write(octal(data.length, 12), 124);
	header.write(octal(MTIME, 12), 136);
	header.write("        ", 148); // checksum placeholder: eight spaces
	header.write("0", 156); // regular file
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write(prefix, 345, 155);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header, data, padding]);
}

/** A gzipped tar of `files` (paths relative to `base`), all under the top-level folder `top`. */
export function packTarGz(base, top, files) {
	const parts = files.map((rel) => {
		const executable = statSync(join(base, rel)).mode & 0o111;
		return tarEntry(`${top}/${rel}`, readFileSync(join(base, rel)), executable ? 0o755 : 0o644);
	});
	parts.push(Buffer.alloc(1024)); // end of archive
	return gzipSync(Buffer.concat(parts), { level: 9 });
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

function bundleReadme(version) {
	return `Kitting ${version}: release bundle

This archive holds the built application and what it needs to be deployed on Cloudflare. It has no source code
and no setting of any installation.

Deploy (Node.js 20 or later; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment):

  KITTING_DOMAIN=kitting.example.com \\
  D1_DATABASE_ID=... TEAM_DOMAIN=your-team.cloudflareaccess.com ACCESS_AUD=... ADMIN_EMAILS=admin@example.com \\
  node scripts/deploy-release.mjs

Optional settings: IMAGES_BUCKET, OAUTH_KV_ID, DEFAULT_LOCALE, CURRENCY, WORKER_NAME, D1_DATABASE_NAME.
Add --dry-run to generate wrangler.jsonc and check the upload without touching your account.
Upgrading is the same command with the bundle of the new version: it applies the pending migrations first.

Contents: worker/index.js (the Worker), public/ (static files), migrations/ (D1), scripts/ (this tool),
wrangler.example.jsonc (the template of the generated wrangler.jsonc), release.json (version and the wrangler
version used to deploy).
`;
}

export function buildRelease() {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const version = pkg.version;
	const wrangler = pkg.devDependencies?.wrangler;
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version is not x.y.z: ${version}`);
	if (!/^\d+\.\d+\.\d+$/.test(wrangler ?? ""))
		throw new Error(`wrangler must be pinned to an exact version: ${wrangler}`);

	const name = `kitting-${version}`;
	const staging = join(dist, "release", name);
	const work = join(dist, "release-work");
	rmSync(join(dist, "release"), { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });

	// 1. The stylesheet (public/static/app.css is built, not committed), then the Worker. wrangler bundles it with the
	// template's settings; none of them end up in the output (bindings and vars live in the config, not the code).
	run("npm", ["run", "css"]);
	run("npx", [
		"--no-install",
		"wrangler",
		"deploy",
		"--dry-run",
		"--outdir",
		work,
		"--config",
		"wrangler.example.jsonc",
	]);
	const built = join(work, "index.js");
	if (!existsSync(built)) throw new Error("wrangler did not produce index.js");
	const extra = readdirSync(work).filter((f) => !["index.js", "index.js.map", "README.md"].includes(f));
	if (extra.length)
		throw new Error(`Unexpected files next to the Worker (the bundle must be one file): ${extra.join(", ")}`);
	const code = readFileSync(built);
	if (code.includes(root)) throw new Error("The built Worker contains the absolute path of this checkout");
	mkdirSync(join(staging, "worker"));
	writeFileSync(join(staging, "worker", "index.js"), code);

	// 2. Static files, migrations (SQL only, not drizzle's meta/ journal), config template and tools.
	cpSync(join(root, "public"), join(staging, "public"), { recursive: true });
	if (!existsSync(join(staging, "public", "static", "app.css"))) throw new Error("public/static/app.css is missing");
	mkdirSync(join(staging, "migrations"));
	for (const file of readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")))
		cpSync(join(root, "migrations", file), join(staging, "migrations", file));
	mkdirSync(join(staging, "scripts"));
	for (const file of ["gen-wrangler-config.mjs", "deploy-release.mjs"])
		cpSync(join(root, "scripts", file), join(staging, "scripts", file));
	cpSync(join(root, "wrangler.example.jsonc"), join(staging, "wrangler.example.jsonc"));
	cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
	writeFileSync(join(staging, "README.txt"), bundleReadme(version));
	writeFileSync(
		join(staging, "release.json"),
		`${JSON.stringify({ name: "kitting", version, wrangler, main: "worker/index.js" }, null, 2)}\n`,
	);
	rmSync(work, { recursive: true, force: true });

	// 3. The archive and its checksum, in the format `sha256sum -c` reads.
	const archive = `${name}.tar.gz`;
	const tarball = packTarGz(staging, name, listFiles(staging));
	writeFileSync(join(dist, archive), tarball);
	const digest = createHash("sha256").update(tarball).digest("hex");
	writeFileSync(join(dist, `${archive}.sha256`), `${digest}  ${archive}\n`);
	console.log(`${archive} (${(tarball.length / 1024).toFixed(0)} KiB)\nsha256 ${digest}`);
	return { archive: join(dist, archive), staging, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		buildRelease();
	} catch (err) {
		console.error(`Cannot build the release bundle: ${err.message}`);
		process.exit(1);
	}
}
