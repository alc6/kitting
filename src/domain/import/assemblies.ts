import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
	ASSEMBLY_STATUSES,
	type AssemblyStatus,
	assemblies,
	assemblyLines,
	machineTypes,
	priceHistory,
} from "../../db/schema";
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
	/** Units per batch (D145); empty = not given (0). */
	batch_qty: field.qty({ positive: true, empty: 0 }),
	/** Machine type name and whole minutes per batch (D148); empty = not given. */
	machine: field.text(200),
	machine_minutes: field.int(),
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
	/** Units per batch from the file, null when empty (only used when the batch_qty column is present). */
	batch: number | null;
	/** Machine type and minutes per batch from the file, null when empty (only used when their columns are present). */
	machineTypeId: number | null;
	machineMinutes: number | null;
	lines: { line: number; componentId: number; qtyMilli: number; notes: string }[];
	existing?: GraphAssembly;
};

const groupKey = (parentId: number, code: string, revision: string) => `${parentId}|${code}|${revision}`;

/**
 * assemblies.csv: one row per assembly line. Rows are grouped by (parent_ref, code, revision);
 * each group replaces the lines of that assembly (created if new). Activating an assembly archives
 * the previously active assembly of the same parent and code. Cycles are rejected.
 * The optional sale_price column sets the variant's selling price (one value per assembly; empty everywhere
 * clears it); without the column, prices are kept, and a new revision of a variant keeps the variant's (that of its
 * active revision, else its newest, D166). The optional batch_qty column works the same way (empty everywhere
 * means 1) and, like the lines, may change an active assembly (D153). The optional machine and machine_minutes columns
 * (a machine type name and whole minutes per batch, D148) follow the same rules.
 */
export const assembliesImporter: Importer = {
	type: "assemblies",
	required: ["parent_ref", "component_ref", "qty"],
	optional: ["code", "revision", "status", "sale_price", "batch_qty", "machine", "machine_minutes", "notes"],
	columns: [
		"parent_ref",
		"code",
		"revision",
		"status",
		"sale_price",
		"batch_qty",
		"machine",
		"machine_minutes",
		"component_ref",
		"qty",
		"notes",
	],
	example: [
		["SA-MAIN", "std", "Rev1", "active", "", "", "", "", "RES-10K", "4", ""],
		["SA-MAIN", "std", "Rev1", "active", "", "", "", "", "CBL-2C", "0.35", "cut to length"],
		["SA-MAIN", "std", "Rev1", "active", "", "", "", "", "KIT-SCREWS", "1", ""],
		["KIT-SCREWS", "std", "Rev1", "active", "", "", "", "", "SCREW-M3", "6", ""],
		["SPACER-10", "std", "Rev1", "active", "", "24", "FDM printer", "190", "PLA-BLACK", "0.26", "one print plate"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("assemblies", errors, warnings);

		const [graph, assemblyPrices, types] = await Promise.all([
			loadGraph(db),
			db.select({ id: assemblies.id, salePriceCents: assemblies.salePriceCents }).from(assemblies),
			db.select({ id: machineTypes.id, name: machineTypes.name }).from(machineTypes),
		]);
		const typeByName = new Map(types.map((m) => [m.name.toLowerCase(), m.id]));
		const typeName = (id: number | null) => (id === null ? "∅" : (types.find((m) => m.id === id)?.name ?? `#${id}`));
		const priceOf = new Map(assemblyPrices.map((b) => [b.id, b.salePriceCents]));
		const pricesInFile = table.header.includes("sale_price");
		// The price a new revision keeps without the column (D166): its variant's active revision's, else its newest's
		// (the last one set wins).
		const variantPrice = new Map<string, number | null>();
		const activeLast = [...graph.assemblies.values()].sort(
			(x, y) => Number(x.status === "active") - Number(y.status === "active") || x.id - y.id,
		);
		for (const b of activeLast) variantPrice.set(`${b.parentPartId}|${b.code}`, priceOf.get(b.id) ?? null);
		const batchesInFile = table.header.includes("batch_qty");
		const machinesInFile = table.header.includes("machine") || table.header.includes("machine_minutes");
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
			const machineTypeId = d.machine ? (typeByName.get(d.machine.toLowerCase()) ?? null) : null;
			if (d.machine && machineTypeId === null) {
				issues.push({ line: rec.line, column: "machine", key: "unknown_machine_type", vars: { name: d.machine } });
				continue;
			}
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
					batch: d.batch_qty || null,
					machineTypeId,
					machineMinutes: d.machine_minutes || null,
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
			} else if (d.batch_qty && g.batch !== null && d.batch_qty !== g.batch) {
				issues.push({ line: rec.line, column: "batch_qty", key: "assembly_batch_mixed" });
				continue;
			} else if (
				(machineTypeId !== null && g.machineTypeId !== null && machineTypeId !== g.machineTypeId) ||
				(d.machine_minutes && g.machineMinutes !== null && d.machine_minutes !== g.machineMinutes)
			) {
				issues.push({ line: rec.line, column: "machine", key: "assembly_machine_mixed" });
				continue;
			} else {
				if (g.salePrice === null) g.salePrice = d.sale_price;
				if (g.batch === null) g.batch = d.batch_qty || null;
				if (g.machineTypeId === null) g.machineTypeId = machineTypeId;
				if (g.machineMinutes === null) g.machineMinutes = d.machine_minutes || null;
			}
			g.lines.push({ line: rec.line, componentId: comp.id, qtyMilli: d.qty, notes: d.notes });
		}

		// Production settings: from the file when their columns are present, else kept (D146, D148).
		const batchOf = (g: Group) => (batchesInFile ? (g.batch ?? MILLI) : (g.existing?.batchMilli ?? MILLI));
		const machineOf = (g: Group) =>
			machinesInFile
				? { typeId: g.machineTypeId, minutes: g.machineTypeId === null ? 0 : (g.machineMinutes ?? 0) }
				: { typeId: g.existing?.machineTypeId ?? null, minutes: g.existing?.machineMinutes ?? 0 };
		const machineChanged = (g: Group) =>
			g.existing !== undefined &&
			(machineOf(g).typeId !== g.existing.machineTypeId || machineOf(g).minutes !== g.existing.machineMinutes);
		for (const g of groups.values()) {
			if (machinesInFile && g.machineTypeId !== null && !g.machineMinutes)
				issues.push({ line: g.firstLine, column: "machine_minutes", key: "machine_time_required" });
			else if (machinesInFile && g.machineTypeId === null && g.machineMinutes)
				issues.push({ line: g.firstLine, column: "machine", key: "machine_required" });
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
		const next: AssemblyGraph = {
			parts: graph.parts,
			assemblies: new Map(graph.assemblies),
			machineTypes: graph.machineTypes,
		};
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
				batchMilli: batchOf(g),
				machineTypeId: machineOf(g).typeId,
				machineMinutes: machineOf(g).minutes,
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
			if (g.existing && batchOf(g) !== g.existing.batchMilli) {
				changes.push(`batch_qty: ${formatQtyInput(g.existing.batchMilli)} → ${formatQtyInput(batchOf(g))}`);
			}
			if (g.existing && machineChanged(g)) {
				const m = machineOf(g);
				changes.push(
					`machine: ${typeName(g.existing.machineTypeId)} ${g.existing.machineMinutes} min → ${typeName(m.typeId)} ${m.minutes} min`,
				);
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
					// The file's price, else an existing assembly's own, else the price a new revision keeps.
					const oldPrice = g.existing ? (priceOf.get(g.existing.id) ?? null) : null;
					const newPrice = pricesInFile
						? g.salePrice
						: g.existing
							? oldPrice
							: (variantPrice.get(`${g.parentId}|${g.code}`) ?? null);
					// Without the column, an existing assembly's price is left untouched.
					const price = pricesInFile || !g.existing ? { salePriceCents: newPrice } : {};
					const batch = {
						...(batchesInFile ? { batchQtyMilli: batchOf(g) } : {}),
						...(machinesInFile ? { machineTypeId: machineOf(g).typeId, machineMinutes: machineOf(g).minutes } : {}),
					};
					if (g.existing) {
						stmts.push(
							db
								.update(assemblies)
								.set({ status: g.status, ...price, ...batch, ...audit })
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
								...batch,
								createdBy: user,
								createdAt: now,
								...audit,
							}),
						);
					}
					const assemblyId = sql`(SELECT id FROM assemblies WHERE parent_part_id = ${g.parentId} AND code = ${g.code} AND revision = ${g.revision})`;
					if (newPrice !== oldPrice) {
						stmts.push(
							db.insert(priceHistory).values({
								partId: g.parentId,
								kind: "sale",
								assemblyId,
								priceCents: newPrice,
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
			batch_qty_milli: number;
			machine: string | null;
			machine_minutes: number;
			component_ref: string;
			qty_milli: number;
			notes: string;
		}>(sql`
			SELECT p.ref AS parent_ref, b.code, b.revision, b.status, b.sale_price_cents, b.batch_qty_milli,
				m.name AS machine, b.machine_minutes, c.ref AS component_ref, l.qty_milli, l.notes
			FROM assembly_lines l
			JOIN assemblies b ON b.id = l.assembly_id
			JOIN parts p ON p.id = b.parent_part_id
			JOIN parts c ON c.id = l.component_part_id
			LEFT JOIN machine_types m ON m.id = b.machine_type_id
			ORDER BY p.ref, b.code, b.revision, l.position, l.id`);
		return rows.map((r) => [
			r.parent_ref,
			r.code,
			r.revision,
			r.status,
			r.sale_price_cents === null ? "" : formatCentsInput(r.sale_price_cents, locale),
			formatQtyInput(r.batch_qty_milli, locale),
			r.machine ?? "",
			r.machine && r.machine_minutes ? String(r.machine_minutes) : "",
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
