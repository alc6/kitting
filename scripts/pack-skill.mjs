// Packs the Kitting skill as a zip for claude.ai (Customize > Skills > Upload), with no dependency:
//   npm run skill:zip   ->   dist/kitting-skill.zip   (dist/ is gitignored)
// The zip holds the skill folder as its top level (kitting/SKILL.md, kitting/references/...), as claude.ai requires.
// Same files and bytes every run (fixed timestamps), so the archive can be compared or checksummed.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "plugins", "kitting", "skills");
const skill = "kitting";
const out = join(root, "dist", "kitting-skill.zip");

/** Every file under a directory, sorted, as paths relative to `base` with forward slashes. */
function files(dir, base = dir) {
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
		.map((p) => p.split(sep).join("/"));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// DOS time 00:00, date 2026-01-01.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const local = [];
const central = [];
let offset = 0;
for (const rel of files(join(skillsDir, skill), skillsDir)) {
	const data = readFileSync(join(skillsDir, rel));
	const packed = deflateRawSync(data, { level: 9 });
	const name = Buffer.from(rel);
	const crc = crc32(data);
	// Version 2.0 (deflate), UTF-8 names (flag bit 11).
	const common = [20, 0x0800, 8, DOS_TIME, DOS_DATE, crc, packed.length, data.length, name.length, 0];
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(common[0], 4);
	header.writeUInt16LE(common[1], 6);
	header.writeUInt16LE(common[2], 8);
	header.writeUInt16LE(common[3], 10);
	header.writeUInt16LE(common[4], 12);
	header.writeUInt32LE(common[5], 14);
	header.writeUInt32LE(common[6], 18);
	header.writeUInt32LE(common[7], 22);
	header.writeUInt16LE(common[8], 26);
	header.writeUInt16LE(common[9], 28);
	local.push(header, name, packed);
	const entry = Buffer.alloc(46);
	entry.writeUInt32LE(0x02014b50, 0);
	entry.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, version 2.0
	entry.writeUInt16LE(common[0], 6);
	entry.writeUInt16LE(common[1], 8);
	entry.writeUInt16LE(common[2], 10);
	entry.writeUInt16LE(common[3], 12);
	entry.writeUInt16LE(common[4], 14);
	entry.writeUInt32LE(common[5], 16);
	entry.writeUInt32LE(common[6], 20);
	entry.writeUInt32LE(common[7], 24);
	entry.writeUInt16LE(common[8], 28);
	entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: a regular file, rw-r--r--
	entry.writeUInt32LE(offset, 42);
	central.push(entry, name);
	offset += header.length + name.length + packed.length;
}

const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${relative(root, out)}: ${central.length / 2} files from plugins/kitting/skills/${skill}/`);
