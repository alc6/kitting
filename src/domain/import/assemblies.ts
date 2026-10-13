import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ASSEMBLY_STATUSES, type AssemblyStatus, assemblies, assemblyLines, priceHistory } from "../../db/schema";
import type { Statement } from "../../lib/db";
import { formatCentsInput, formatQtyInput, MILLI } from "../../lib/units";
import { field, REF_PATTERN, validate } from "../../lib/validation";
import { DEFAULT_CODE, DEFAULT_REVISION, loadGraph } from "../assemblies";
import { type AssemblyGraph, findCycle, type GraphAssembly, type GraphLine } from "../assembly-graph";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const label = (fallback: string) =>
	z
		.string()
		.trim()
		.transform((v) => v || fallback)
		.refine((v) => v.length <= 64 && REF_PATTERN.test(v), "invalid_ref");

const assemblyRow = z.object({
	parent_ref: field.required(64),
	code: label(DEFAULT_CODE),
	revision: label(DEFAULT_REVISION),
	status: z
		.string()
		.trim()
		.transform((v) => (v || "draft").toLowerCase())
		.refine((v): v is AssemblyStatus => (ASSEMBLY_STATUSES as readonly string[]).includes(v), "invalid_status")
		.transform((v) => v as AssemblyStatus),
	sale_price: field.money(),
	component_ref: field.required(64),
	qty: field.qty({ positive: true }),
	notes: field.text(500),
});

type Group = {
	key: string;
	firstLine: number;
	parentId: number;
	code: string;
	revision: string;
	status: AssemblyStatus;
	/** Variant selling price from the file (only used when the sale_price column is present). */
	salePrice: number | null;
	lines: { line: number; componentId: number; qtyMilli: number; notes: string }[];
	existing?: GraphAssembly;
};

const groupKey = (parentId: number, code: string, revision: string) => `${parentId}|${code}|${revision}`;

/**
 * assemblies.csv: one row per assembly line. Rows are grouped by (parent_ref, code, revision);
 * each group replaces the lines of that assembly (created if new). Activating an assembly archives
 * the previously active assembly of the same parent and code. Cycles are rejected.
 * The optional sale_price column sets the variant's selling price (one value per assembly; empty everywhere
 * clears it); without the column, prices are kept.
 */
export const assembliesImporter: Importer = {
	type: "assemblies",
	required: ["parent_ref", "component_ref", "qty"],
	optional: ["code", "revision", "status", "sale_price", "notes"],
	columns: ["parent_ref", "code", "revision", "status", "sale_price", "component_ref", "qty", "notes"],
	example: [
		["SA-MAIN", "std", "Rev1", "active", "", "RES-10K", "4", ""],
		["SA-MAIN", "std", "Rev1", "active", "", "CBL-2C", "0.35", "cut to length"],
		["SA-MAIN", "std", "Rev1", "active", "", "KIT-SCREWS", "1", ""],
		["KIT-SCREWS", "std", "Rev1", "active", "", "SCREW-M3", "6", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("assemblies", errors, warnings);

		const [graph, assemblyPrices] = await Promise.all([
			loadGraph(db),
			db.select({ id: assemblies.id, salePriceCents: assemblies.salePriceCents }).from(assemblies),
		]);
		const priceOf = new Map(assemblyPrices.map((b) => [b.id, b.salePriceCents]));
		const pricesInFile = table.header.includes("sale_price");
		const byRef = new Map([...graph.parts.values()].map((p) => [p.ref, p]));
		const existingByKey = new Map(
			[...graph.assemblies.values()].map((b) => [groupKey(b.parentPartId, b.code, b.revision), b]),
		);
		const issues: RowIssue[] = [];
		const groups = new Map<string, Group>();

		for (const rec of table.records) {
			const v = validate(assemblyRow, rec.values);
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => f));
				continue;
			}
			const d = v.data;
			const parent = byRef.get(d.parent_ref);
			const comp = byRef.get(d.component_ref);
			if (!parent)
				issues.push({ line: rec.line, column: "parent_ref", key: "unknown_part", vars: { ref: d.parent_ref } });
			else if (parent.kind !== "make" && parent.kind !== "kit")
				issues.push({ line: rec.line, column: "parent_ref", key: "assembly_parent_kind" });
			if (!comp)
				issues.push({ line: rec.line, column: "component_ref", key: "unknown_part", vars: { ref: d.component_ref } });
			if (parent && comp && parent.id === comp.id) {
				issues.push({
					line: rec.line,
					column: "component_ref",
					key: "assembly_cycle",
					vars: { ref: comp.ref, parent: parent.ref },
				});
			}
			if (comp?.trackSerial && d.qty % MILLI !== 0) {
				issues.push({ line: rec.line, column: "qty", key: "serial_whole_qty" });
				continue;
			}
			if (!parent || !comp || parent.id === comp.id || (parent.kind !== "make" && parent.kind !== "kit")) continue;
			const key = groupKey(parent.id, d.code, d.revision);
			let g = groups.get(key);
			if (!g) {
				g = {
					key,
					firstLine: rec.line,
					parentId: parent.id,
					code: d.code,
					revision: d.revision,
					status: d.status,
					salePrice: d.sale_price,
					lines: [],
					existing: existingByKey.get(key),
				};
				groups.set(key, g);
			} else if (g.status !== d.status) {
				issues.push({ line: rec.line, column: "status", key: "assembly_status_mixed" });
				continue;
			} else if (d.sale_price !== null && g.salePrice !== null && d.sale_price !== g.salePrice) {
				issues.push({ line: rec.line, column: "sale_price", key: "assembly_price_mixed" });
				continue;
			} else if (g.salePrice === null) g.salePrice = d.sale_price;
			g.lines.push({ line: rec.line, componentId: comp.id, qtyMilli: d.qty, notes: d.notes });
		}

		// At most one active assembly per (parent, code) in the file.
		const activeInFile = new Map<string, Group>();
		for (const g of groups.values()) {
			if (g.status !== "active") continue;
			const k = `${g.parentId}|${g.code}`;
			const other = activeInFile.get(k);
			if (other)
				issues.push({
					line: g.firstLine,
					column: "status",
					key: "assembly_two_active",
					vars: { line: other.firstLine },
				});
			else activeInFile.set(k, g);
		}

		// Previously active assemblies that the file replaces get archived.
		const toArchive = [...graph.assemblies.values()].filter(
			(b) =>
				b.status === "active" &&
				activeInFile.has(`${b.parentPartId}|${b.code}`) &&
				!groups.has(groupKey(b.parentPartId, b.code, b.revision)),
		);

		// Apply the changes to a copy of the graph and look for cycles.
		const next: AssemblyGraph = { parts: graph.parts, assemblies: new Map(graph.assemblies) };
		let tempId = -1;
		for (const b of toArchive) next.assemblies.set(b.id, { ...b, status: "archived" });
		for (const g of groups.values()) {
			const id = g.existing?.id ?? tempId--;
			const lines: GraphLine[] = g.lines.map((l, i) => ({
				id: -1000 - i,
				componentPartId: l.componentId,
				qtyMilli: l.qtyMilli,
				position: i + 1,
				notes: l.notes,
			}));
			next.assemblies.set(id, {
				id,
				parentPartId: g.parentId,
				code: g.code,
				revision: g.revision,
				status: g.status,
				lines,
			});
		}
		const cycle = findCycle(next);
		if (cycle) {
			const g = [...groups.values()].find((x) => cycle.includes(graph.parts.get(x.parentId)?.ref ?? ""));
			issues.push({ line: g?.firstLine ?? 1, key: "assembly_cycle_path", vars: { path: cycle.join(" → ") } });
		}

		const ref = (id: number) => graph.parts.get(id)?.ref ?? String(id);
		const rows: PlanRow[] = [];
		const changed: Group[] = [];
		for (const g of groups.values()) {
			const changes = g.existing ? diffAssembly(g, g.existing, ref) : [];
			const oldPrice = g.existing ? (priceOf.get(g.existing.id) ?? null) : null;
			if (g.existing && pricesInFile && oldPrice !== g.salePrice) {
				const money = (v: number | null) => (v === null ? "∅" : formatCentsInput(v));
				changes.push(`sale_price: ${money(oldPrice)} → ${money(g.salePrice)}`);
			}
			for (const b of toArchive) {
				if (b.parentPartId === g.parentId && b.code === g.code && g.status === "active") {
					changes.push(`${b.revision}: active → archived`);
				}
			}
			const action = !g.existing ? "create" : changes.length ? "update" : "unchanged";
			if (action !== "unchanged") changed.push(g);
			rows.push({
				line: g.firstLine,
				action,
				cells: [ref(g.parentId), g.code, g.revision, g.status, String(g.lines.length)],
				changes,
			});
		}

		return {
			type: "assemblies",
			previewColumns: ["parent_ref", "code", "revision", "status", "lines"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) => {
				const stmts: Statement[] = [];
				const audit = { updatedAt: now, updatedBy: user };
				if (toArchive.length) {
					stmts.push(
						db
							.update(assemblies)
							.set({ status: "archived", ...audit })
							.where(
								inArray(
									assemblies.id,
									toArchive.map((b) => b.id),
								),
							),
					);
				}
				// Non-active statuses first, so an activation never meets another active assembly.
				const ordered = [...changed].sort((a, b) => Number(a.status === "active") - Number(b.status === "active"));
				for (const g of ordered) {
					const price = pricesInFile ? { salePriceCents: g.salePrice } : {};
					const oldPrice = g.existing ? (priceOf.get(g.existing.id) ?? null) : null;
					if (g.existing) {
						stmts.push(
							db
								.update(assemblies)
								.set({ status: g.status, ...price, ...audit })
								.where(eq(assemblies.id, g.existing.id)),
						);
						stmts.push(db.delete(assemblyLines).where(eq(assemblyLines.assemblyId, g.existing.id)));
					} else {
						stmts.push(
							db.insert(assemblies).values({
								parentPartId: g.parentId,
								code: g.code,
								revision: g.revision,
								status: g.status,
								...price,
								createdBy: user,
								createdAt: now,
								...audit,
							}),
						);
					}
					const assemblyId = sql`(SELECT id FROM assemblies WHERE parent_part_id = ${g.parentId} AND code = ${g.code} AND revision = ${g.revision})`;
					if (pricesInFile && g.salePrice !== oldPrice) {
						stmts.push(
							db.insert(priceHistory).values({
								partId: g.parentId,
								kind: "sale",
								assemblyId,
								priceCents: g.salePrice,
								validFrom: now.slice(0, 10),
								source: "import",
								createdBy: user,
								createdAt: now,
								...audit,
							}),
						);
					}
					g.lines.forEach((l, i) => {
						stmts.push(
							db.insert(assemblyLines).values({
								assemblyId,
								componentPartId: l.componentId,
								qtyMilli: l.qtyMilli,
								position: i + 1,
								notes: l.notes,
								createdBy: user,
								createdAt: now,
								...audit,
							}),
						);
					});
				}
				return stmts;
			},
		};
	},

	async exportRows({ db, locale }) {
		const rows = await db.all<{
			parent_ref: string;
			code: string;
			revision: string;
			status: string;
			sale_price_cents: number | null;
			component_ref: string;
			qty_milli: number;
			notes: string;
		}>(sql`
			SELECT p.ref AS parent_ref, b.code, b.revision, b.status, b.sale_price_cents, c.ref AS component_ref, l.qty_milli, l.notes
			FROM assembly_lines l
			JOIN assemblies b ON b.id = l.assembly_id
			JOIN parts p ON p.id = b.parent_part_id
			JOIN parts c ON c.id = l.component_part_id
			ORDER BY p.ref, b.code, b.revision, l.position, l.id`);
		return rows.map((r) => [
			r.parent_ref,
			r.code,
			r.revision,
			r.status,
			r.sale_price_cents === null ? "" : formatCentsInput(r.sale_price_cents, locale),
			r.component_ref,
			formatQtyInput(r.qty_milli, locale),
			r.notes,
		]);
	},
};

function diffAssembly(g: Group, existing: GraphAssembly, ref: (id: number) => string): string[] {
	const changes: string[] = [];
	if (existing.status !== g.status) changes.push(`status: ${existing.status} → ${g.status}`);
	const sameLines =
		existing.lines.length === g.lines.length &&
		existing.lines.every((l, i) => {
			const n = g.lines[i];
			return n && n.componentId === l.componentPartId && n.qtyMilli === l.qtyMilli && n.notes === l.notes;
		});
	if (sameLines) return changes;
	const total = (pairs: { id: number; qty: number }[]) => {
		const m = new Map<number, number>();
		for (const p of pairs) m.set(p.id, (m.get(p.id) ?? 0) + p.qty);
		return m;
	};
	const before = total(existing.lines.map((l) => ({ id: l.componentPartId, qty: l.qtyMilli })));
	const after = total(g.lines.map((l) => ({ id: l.componentId, qty: l.qtyMilli })));
	for (const [id, qty] of after) {
		const old = before.get(id);
		if (old === undefined) changes.push(`+ ${ref(id)} × ${formatQtyInput(qty)}`);
		else if (old !== qty) changes.push(`${ref(id)}: ${formatQtyInput(old)} → ${formatQtyInput(qty)}`);
	}
	for (const [id] of before) if (!after.has(id)) changes.push(`− ${ref(id)}`);
	if (changes.length === (existing.status !== g.status ? 1 : 0)) changes.push("lines reordered or notes changed");
	return changes;
}
