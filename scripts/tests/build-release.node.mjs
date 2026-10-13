// Node tests for the archive writer of scripts/build-release.mjs: `npm run test:scripts`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { listFiles, packTarGz } from "../build-release.mjs";

test("packs a folder as a tar.gz that tar reads back, whatever the tar flavour", () => {
	const dir = mkdtempSync(join(tmpdir(), "kitting-tar-"));
	const out = mkdtempSync(join(tmpdir(), "kitting-untar-"));
	try {
		const folder = "nested-directory-with-a-long-name/".repeat(4);
		const deep = `${folder}file.txt`;
		mkdirSync(join(dir, "a"));
		mkdirSync(join(dir, folder), { recursive: true });
		writeFileSync(join(dir, "a", "one.txt"), "one\n");
		writeFileSync(join(dir, "big.bin"), Buffer.alloc(1500, 7));
		writeFileSync(join(dir, "tool.mjs"), "#!/usr/bin/env node\n");
		chmodSync(join(dir, "tool.mjs"), 0o755);
		writeFileSync(join(dir, deep), "deep\n");

		const files = listFiles(dir);
		assert.deepEqual(files, ["a/one.txt", "big.bin", deep, "tool.mjs"].sort());
		const archive = packTarGz(dir, "kitting-1.2.3", files);
		assert.deepEqual(archive, packTarGz(dir, "kitting-1.2.3", files), "same bytes on every run");
		writeFileSync(join(out, "x.tar.gz"), archive);

		const listing = spawnSync("tar", ["-tzf", join(out, "x.tar.gz")], { encoding: "utf8" });
		assert.equal(listing.status, 0, listing.stderr);
		assert.deepEqual(
			listing.stdout.trim().split("\n"),
			files.map((f) => `kitting-1.2.3/${f}`),
		);

		const extract = spawnSync("tar", ["-xzf", join(out, "x.tar.gz"), "-C", out]);
		assert.equal(extract.status, 0, extract.stderr?.toString());
		const top = join(out, "kitting-1.2.3");
		assert.equal(readFileSync(join(top, "a", "one.txt"), "utf8"), "one\n");
		assert.equal(readFileSync(join(top, deep), "utf8"), "deep\n");
		assert.deepEqual(readFileSync(join(top, "big.bin")), Buffer.alloc(1500, 7));
		assert.ok(statSync(join(top, "tool.mjs")).mode & 0o100, "executable bit kept");
		assert.equal(statSync(join(top, "a", "one.txt")).mode & 0o111, 0);
		assert.equal(gunzipSync(archive).length % 512, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});

test("refuses a path that ustar cannot hold", () => {
	const dir = mkdtempSync(join(tmpdir(), "kitting-tar-"));
	try {
		const name = "x".repeat(120);
		writeFileSync(join(dir, name), "x");
		assert.throws(() => packTarGz(dir, "t", [name]), /Path too long/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
