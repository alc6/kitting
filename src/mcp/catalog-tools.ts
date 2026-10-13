// catalog:write tools (D127): parts, suppliers and BoMs, through the same validation and statement builders as
// the pages. BoMs change only through draft revisions: set_bom_lines never edits an active BoM in place, and
// activate_bom is the separate, explicit step (D128).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Bom, boms, PART_KINDS, type Part } from "../db/schema";
import {
	activateStatements,
	archivedBomCycles,
	bomInput,
	bomLabel,
	bomLineInput,
	componentError,
	createBomStatements,
	DEFAULT_CODE,
	DEFAULT_REVISION,
	findBom,
	getBomLines,
	loadGraph,
	newBomErrors,
	nextRevision,
	replaceBomLinesStatements,
	setBomStatusStatement,
} from "../domain/boms";
import { getOffer } from "../domain/offers";
import { archivePartStatement, checkPart, getPart, partToForm, savePartStatements } from "../domain/parts";
import {
	createSupplierStatement,
	findSupplierByName,
	supplierInput,
	supplierNameTaken,
	supplierToForm,
	updateSupplierStatement,
} from "../domain/suppliers";
import { fmt } from "../i18n";
import { validate } from "../lib/validation";
import type { Db } from "../types";
import {
	bomSelector,
	decimal,
	errorMessage,
	findPart,
	formValue,
	NOTHING_CHANGED,
	partByRef,
	partRef,
	refuse,
	resolveBom,
	saveChange,
	type ToolContext,
	ToolError,
	type ToolSpec,
	tool,
	writes,
} from "./kit";

const now = () => new Date().toISOString();

const partView = (p: Part) => ({
	ref: p.ref,
	name: p.name,
	kind: p.kind,
	unit: p.unit,
	trackSerial: p.trackSerial,
	archived: p.archived,
	notes: p.notes,
});

const bomView = (b: Pick<Bom, "id" | "code" | "revision" | "status">, partRef: string) => ({
	bomId: b.id,
	part: partRef,
	code: b.code,
	revision: b.revision,
	status: b.status,
});

/** Part fields a catalogue tool may set (prices go through prices:write, supplier terms through offers). */
const partFields = {
	name: z.string().max(200).describe('Name, e.g. "Desk lamp".'),
	kind: z
		.enum(PART_KINDS)
		.describe("buy: purchased; make: built from a BoM, stocked; kit: phantom BoM, never stocked; fee: cost only."),
	unit: z.string().max(20).describe('Unit of quantities, e.g. "pcs" (the default), "m", "kg".'),
	track_serial: z.boolean().describe("One serial number per unit (buy and make parts only)."),
	notes: z.string().max(2000),
};

const createPart = tool({
	name: "create_part",
	title: "Create a part",
	description:
		"Creates a part in the catalogue, with the same checks as the part form (unique reference ignoring case, serial tracking only for buy and make parts). Prices and supplier offers are set separately (set_standard_cost, set_sale_price, upsert_supplier_offer).",
	rule: { scope: "catalog:write", action: "parts.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		ref: z.string().max(64).describe('Unique reference: letters, digits and - _ . / (e.g. "LED-5W-CW").'),
		name: partFields.name,
		kind: partFields.kind,
		unit: partFields.unit.optional(),
		track_serial: partFields.track_serial.default(false),
		notes: partFields.notes.default(""),
	}),
	run: async (a, ctx) => {
		const form = {
			ref: a.ref,
			name: a.name,
			kind: a.kind,
			unit: a.unit ?? "",
			track_serial: formValue(a.track_serial),
			notes: a.notes,
		};
		const v = await checkPart(ctx.db, form);
		if (!v.ok) refuse(v.errors, { ref: v.clashRef ?? "" });
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.partCreate, { ref: v.data.ref }),
			savePartStatements(ctx.db, v.data, undefined, "form", ctx.user, now()),
		);
		const created = await partByRef(ctx.db, v.data.ref);
		return { ...change, part: partView(created) };
	},
});

const updatePart = tool({
	name: "update_part",
	title: "Edit a part",
	description:
		"Changes a part's reference, name, kind, unit, serial tracking or notes; fields left out keep their value. Same checks as the part form (a part with stock moves cannot become a kit or fee, a part with BoMs stays make or kit). Prices and offers are not changed here.",
	rule: { scope: "catalog:write", action: "parts.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		ref: partRef,
		new_ref: z.string().max(64).optional().describe("A new reference, to rename the part."),
		name: partFields.name.optional(),
		kind: partFields.kind.optional(),
		unit: partFields.unit.optional(),
		track_serial: partFields.track_serial.optional(),
		notes: partFields.notes.optional(),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.ref);
		const offer = part.supplierId ? await getOffer(ctx.db, part.id, part.supplierId) : undefined;
		// The current values (prices and preferred offer terms included), with the given fields replaced.
		const form: Record<string, string> = { ...partToForm(part, "en", offer) };
		if (a.new_ref !== undefined) form.ref = a.new_ref;
		if (a.name !== undefined) form.name = a.name;
		if (a.kind !== undefined) form.kind = a.kind;
		if (a.unit !== undefined) form.unit = a.unit;
		if (a.track_serial !== undefined) form.track_serial = formValue(a.track_serial);
		if (a.notes !== undefined) form.notes = a.notes;
		const v = await checkPart(ctx.db, form, part);
		if (!v.ok) refuse(v.errors, { ref: v.clashRef ?? "" }, { ref: "new_ref" });
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.partEdit, { ref: v.data.ref }),
			savePartStatements(ctx.db, v.data, { part, offer }, "form", ctx.user, now()),
		);
		const updated = await getPart(ctx.db, part.id);
		return { ...change, part: updated ? partView(updated) : null };
	},
});

// ---------------------------------------------------------------------------
// Suppliers

const supplierFields = {
	email: z.string().max(200).describe("Ordering email address."),
	phone: z.string().max(50),
	notes: z.string().max(2000),
};

const supplierView = (s: { name: string; email: string; phone: string; notes: string }) => ({
	name: s.name,
	email: s.email,
	phone: s.phone,
	notes: s.notes,
});

const createSupplier = tool({
	name: "create_supplier",
	title: "Create a supplier",
	description: "Creates a supplier (its name must be new, ignoring case). Offers are added with upsert_supplier_offer.",
	rule: { scope: "catalog:write", action: "suppliers.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		name: z.string().max(200),
		email: supplierFields.email.default(""),
		phone: supplierFields.phone.default(""),
		notes: supplierFields.notes.default(""),
	}),
	run: async (a, ctx) => {
		const v = validate(supplierInput, a);
		if (!v.ok) refuse(v.errors);
		if (await supplierNameTaken(ctx.db, v.data.name)) refuse({ name: "duplicate_name" });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.supplierCreate, { name: v.data.name }), [
			createSupplierStatement(ctx.db, v.data, ctx.user, now()),
		]);
		return { ...change, supplier: supplierView(v.data) };
	},
});

/** A supplier by name, ignoring case. */
export async function supplierByName(db: Db, name: string) {
	const found = await findSupplierByName(db, name);
	if (!found) throw new ToolError(`No supplier named "${name}". get_part lists the suppliers of a part's offers.`);
	return found;
}

const updateSupplier = tool({
	name: "update_supplier",
	title: "Edit a supplier",
	description: "Changes a supplier's name, email, phone or notes; fields left out keep their value.",
	rule: { scope: "catalog:write", action: "suppliers.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		name: z.string().trim().min(1).max(200).describe("The supplier's current name (case-insensitive)."),
		new_name: z.string().max(200).optional(),
		email: supplierFields.email.optional(),
		phone: supplierFields.phone.optional(),
		notes: supplierFields.notes.optional(),
	}),
	run: async (a, ctx) => {
		const supplier = await supplierByName(ctx.db, a.name);
		const form = { ...supplierToForm(supplier) };
		if (a.new_name !== undefined) form.name = a.new_name;
		if (a.email !== undefined) form.email = a.email;
		if (a.phone !== undefined) form.phone = a.phone;
		if (a.notes !== undefined) form.notes = a.notes;
		const v = validate(supplierInput, form);
		if (!v.ok) refuse(v.errors, {}, { name: "new_name" });
		if (await supplierNameTaken(ctx.db, v.data.name, supplier.id))
			refuse({ name: "duplicate_name" }, {}, { name: "new_name" });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.supplierEdit, { name: v.data.name }), [
			updateSupplierStatement(ctx.db, supplier.id, v.data, ctx.user, now()),
		]);
		return { ...change, supplier: supplierView(v.data) };
	},
});

// ---------------------------------------------------------------------------
// BoMs

/** The BoM named by a selector, with its parent part. */
async function selectBom(db: Db, sel: z.output<z.ZodObject<typeof bomSelector>>) {
	return resolveBom(db, await loadGraph(db), sel);
}

/** The next free revision label of a BoM's (parent, code), e.g. Rev2 → Rev3. */
async function newRevisionLabel(db: Db, bom: Bom): Promise<string> {
	const taken = await db
		.select({ revision: boms.revision })
		.from(boms)
		.where(and(eq(boms.parentPartId, bom.parentPartId), eq(boms.code, bom.code)));
	return nextRevision(
		bom.revision,
		taken.map((r) => r.revision),
	);
}

async function linesView(db: Db, bomId: number) {
	return (await getBomLines(db, bomId)).map((l) => ({ ref: l.ref, qtyMilli: l.qtyMilli, notes: l.notes || undefined }));
}

const createBom = tool({
	name: "create_bom",
	title: "Create a BoM",
	description:
		"Creates a draft BoM for a make or kit part, empty or copied from another BoM (same checks as the new BoM form: (code, revision) new for the part, no cycle). Set its lines with set_bom_lines, then activate it with activate_bom.",
	rule: { scope: "catalog:write", action: "boms.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		part: partRef.describe("Reference of the make or kit part the BoM builds."),
		code: z.string().max(64).default(DEFAULT_CODE).describe(`Variant code (default "${DEFAULT_CODE}").`),
		revision: z.string().max(64).default(DEFAULT_REVISION).describe(`Revision label (default "${DEFAULT_REVISION}").`),
		notes: z.string().max(2000).default(""),
		copy_from: z.object(bomSelector).optional().describe("A BoM to copy the lines from (of this part or another one)."),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.part);
		const source = a.copy_from ? (await selectBom(ctx.db, a.copy_from)).bom : undefined;
		const v = validate(bomInput, {
			parent_part_id: String(part.id),
			code: a.code,
			revision: a.revision,
			notes: a.notes,
			copy_from: source ? String(source.id) : "",
		});
		if (!v.ok) refuse(v.errors);
		const d = v.data;
		const errors = await newBomErrors(ctx.db, {
			parentPartId: part.id,
			code: d.code,
			revision: d.revision,
			copyFrom: d.copy_from,
		});
		if (Object.keys(errors).length) refuse(errors, {}, { parent_part_id: "part" });
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.bomCreate, { bom: bomLabel(part.ref, d) }),
			createBomStatements(
				ctx.db,
				{ parentPartId: part.id, code: d.code, revision: d.revision, notes: d.notes },
				d.copy_from,
				ctx.user,
				now(),
			),
		);
		const created = await findBom(ctx.db, part.id, d.code, d.revision);
		if (!created) throw new Error("created BoM not found");
		return { ...change, bom: bomView(created, part.ref), lines: await linesView(ctx.db, created.id) };
	},
});

const setBomLines = tool({
	name: "set_bom_lines",
	title: "Set the lines of a BoM",
	description:
		"Replaces all the lines of a BoM at once, in the given order, with the editor's checks on every line (known part, not archived, whole units for serial-tracked parts, no cycle); nothing changes if one line is refused. An active BoM is never edited in place: a new draft revision is created with these lines, and the active one stays as it is until you call activate_bom on the new revision. Archived BoMs are read-only.",
	rule: { scope: "catalog:write", action: "boms.edit" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		...bomSelector,
		lines: z
			.array(
				z.object({
					ref: partRef.describe("Component part reference."),
					qty: decimal('Quantity per unit of the parent, e.g. "2" or "0.5", in the component\'s unit.'),
					notes: z.string().max(500).default(""),
				}),
			)
			.min(1)
			.max(500),
	}),
	run: async (a, ctx) => {
		const { bom, part } = await selectBom(ctx.db, a);
		const label = bomLabel(part.ref, bom);
		if (bom.status === "archived")
			throw new ToolError(`BoM ${label} is archived: ${errorMessage("bom_archived")} Copy it with new_bom_revision.`);
		const lines: { componentPartId: number; qtyMilli: number; notes: string }[] = [];
		const problems: string[] = [];
		for (const [i, l] of a.lines.entries()) {
			const at = `line ${i + 1} (${l.ref})`;
			const v = validate(bomLineInput, { component: l.ref, qty: formValue(l.qty), notes: l.notes });
			if (!v.ok) {
				problems.push(...Object.entries(v.errors).map(([f, key]) => `${at} ${f}: ${errorMessage(key)}`));
				continue;
			}
			const component = await findPart(ctx.db, l.ref);
			const problem = await componentError(ctx.db, part, component, l.ref, v.data.qty);
			if (problem) problems.push(`${at} ${problem.field}: ${errorMessage(problem.key, problem.vars)}`);
			else if (component) lines.push({ componentPartId: component.id, qtyMilli: v.data.qty, notes: v.data.notes });
		}
		if (problems.length) throw new ToolError(`Refused, nothing was changed. ${problems.join(" ")}`);
		const t = ctx.t.history.summaries;
		if (bom.status === "active") {
			// The guardrail (D128): the active BoM stays as it is; the lines go on a new draft revision.
			const revision = await newRevisionLabel(ctx.db, bom);
			const target = { parentPartId: bom.parentPartId, code: bom.code, revision };
			const stamp = now();
			const { change } = await saveChange(
				ctx,
				fmt(t.bomRevisionLines, { bom: bomLabel(part.ref, target), from: bom.revision }),
				[
					...createBomStatements(ctx.db, { ...target, notes: bom.notes }, null, ctx.user, stamp),
					...replaceBomLinesStatements(ctx.db, target, lines, ctx.user, stamp),
				],
			);
			const created = await findBom(ctx.db, bom.parentPartId, bom.code, revision);
			if (!created) throw new Error("new revision not found");
			return {
				...change,
				bom: bomView(created, part.ref),
				newRevision: true,
				activeBom: bomView(bom, part.ref),
				note: `${label} is active and was left unchanged: the lines were set on the new draft revision ${revision}. Call activate_bom on ${revision} to make builds use it.`,
				lines: await linesView(ctx.db, created.id),
			};
		}
		const { change } = await saveChange(
			ctx,
			fmt(t.bomLines, { bom: label }),
			replaceBomLinesStatements(ctx.db, bom.id, lines, ctx.user, now()),
		);
		return { ...change, bom: bomView(bom, part.ref), newRevision: false, lines: await linesView(ctx.db, bom.id) };
	},
});

const newBomRevision = tool({
	name: "new_bom_revision",
	title: "New BoM revision",
	description:
		"Copies a BoM (any status) into a new draft revision of the same part and variant code (Rev2 → Rev3), as the BoM page's New revision button does. The original is not changed.",
	rule: { scope: "catalog:write", action: "boms.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object(bomSelector),
	run: async (a, ctx) => {
		const { bom, part } = await selectBom(ctx.db, a);
		const revision = await newRevisionLabel(ctx.db, bom);
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.bomRevision, {
				bom: bomLabel(part.ref, { code: bom.code, revision }),
				from: bom.revision,
			}),
			createBomStatements(
				ctx.db,
				{ parentPartId: bom.parentPartId, code: bom.code, revision, notes: bom.notes },
				bom.id,
				ctx.user,
				now(),
			),
		);
		const created = await findBom(ctx.db, bom.parentPartId, bom.code, revision);
		if (!created) throw new Error("new revision not found");
		return {
			...change,
			bom: bomView(created, part.ref),
			from: bomView(bom, part.ref),
			lines: await linesView(ctx.db, created.id),
		};
	},
});

const activateBom = tool({
	name: "activate_bom",
	title: "Activate a BoM",
	description:
		"Makes a draft or archived BoM the active one of its part and variant code: builds and explosions use it from now on. The previously active revision is archived (and can be activated again later). Give the BoM id or the part with its revision.",
	rule: { scope: "catalog:write", action: "boms.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object(bomSelector),
	run: async (a, ctx: ToolContext) => {
		const { bom, part } = await selectBom(ctx.db, a);
		const label = bomLabel(part.ref, bom);
		if (bom.status === "active")
			return { ...NOTHING_CHANGED, bom: bomView(bom, part.ref), note: `${label} is already active.` };
		if (part.kind !== "make" && part.kind !== "kit") refuse({ bom: "bom_parent_kind" });
		if (await archivedBomCycles(ctx.db, bom))
			throw new ToolError(
				`Refused: activating ${label} would create a cycle (one of its parts now contains ${part.ref}).`,
			);
		const previous = await ctx.db
			.select()
			.from(boms)
			.where(and(eq(boms.parentPartId, bom.parentPartId), eq(boms.code, bom.code), eq(boms.status, "active")));
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.bomActivate, { bom: label }),
			activateStatements(ctx.db, bom, ctx.user, now()),
		);
		return {
			...change,
			bom: { ...bomView(bom, part.ref), status: "active" },
			archived: previous.map((b) => ({ ...bomView(b, part.ref), status: "archived" })),
		};
	},
});

// ---------------------------------------------------------------------------
// catalog:archive (D125): archiving hides a part or BoM and is undone by unarchiving; deleting is never offered.

function archivePartTool(archived: boolean) {
	return tool({
		name: archived ? "archive_part" : "unarchive_part",
		title: archived ? "Archive a part" : "Unarchive a part",
		description: archived
			? "Archives a part: it disappears from lists and pickers (new BoM lines, POs), but its stock, BoMs, builds and history stay. unarchive_part brings it back. Parts are never deleted over MCP."
			: "Brings an archived part back into lists and pickers.",
		rule: { scope: "catalog:archive", action: "parts.archive" },
		annotations: writes({ destructive: archived, idempotent: true }),
		input: z.object({ ref: partRef }),
		run: async (a, ctx) => {
			const part = await partByRef(ctx.db, a.ref);
			if (part.archived === archived)
				return {
					...NOTHING_CHANGED,
					part: partView(part),
					note: `${part.ref} is already ${archived ? "archived" : "active"}.`,
				};
			const summaries = ctx.t.history.summaries;
			const { change } = await saveChange(
				ctx,
				fmt(archived ? summaries.partArchive : summaries.partUnarchive, { ref: part.ref }),
				[archivePartStatement(ctx.db, part.id, archived, ctx.user, now())],
			);
			return { ...change, part: { ...partView(part), archived } };
		},
	});
}

const archiveBom = tool({
	name: "archive_bom",
	title: "Archive a BoM",
	description:
		"Archives a BoM revision: it becomes read-only and is no longer used by builds or explosions (archiving the active one leaves its part and variant without an active BoM until another is activated). activate_bom can bring it back. BoMs are never deleted over MCP.",
	rule: { scope: "catalog:archive", action: "boms.archive" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object(bomSelector),
	run: async (a, ctx) => {
		const { bom, part } = await selectBom(ctx.db, a);
		const label = bomLabel(part.ref, bom);
		if (bom.status === "archived")
			return { ...NOTHING_CHANGED, bom: bomView(bom, part.ref), note: `${label} is already archived.` };
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.bomArchive, { bom: label }), [
			setBomStatusStatement(ctx.db, bom.id, "archived", ctx.user, now()),
		]);
		return { ...change, bom: { ...bomView(bom, part.ref), status: "archived" } };
	},
});

export const CATALOG_TOOLS: readonly ToolSpec[] = [
	createPart,
	updatePart,
	createSupplier,
	updateSupplier,
	createBom,
	setBomLines,
	newBomRevision,
	activateBom,
	archivePartTool(true),
	archivePartTool(false),
	archiveBom,
];
