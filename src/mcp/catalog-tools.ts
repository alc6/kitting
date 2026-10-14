// catalog:write tools (D127): parts, suppliers and assemblies, through the same validation and statement builders as
// the pages. Assemblies change only through draft revisions: set_assembly_lines never edits an active assembly in place, and
// activate_assembly is the separate, explicit step (D128).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Assembly, assemblies, PART_KINDS, type Part } from "../db/schema";
import {
	activateStatements,
	archivedAssemblyCycles,
	assemblyInput,
	assemblyLabel,
	assemblyLineInput,
	componentError,
	createAssemblyStatements,
	DEFAULT_CODE,
	DEFAULT_REVISION,
	findAssembly,
	getAssemblyLines,
	loadGraph,
	newAssemblyErrors,
	nextRevision,
	productionInput,
	replaceAssemblyLinesStatements,
	setAssemblyStatusStatement,
	setProductionStatement,
} from "../domain/assemblies";
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
import { formatQtyInput } from "../lib/units";
import { validate } from "../lib/validation";
import type { Db } from "../types";
import {
	assemblySelector,
	decimal,
	errorMessage,
	findPart,
	formValue,
	NOTHING_CHANGED,
	partByRef,
	partRef,
	refuse,
	resolveAssembly,
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

const assemblyView = (b: Pick<Assembly, "id" | "code" | "revision" | "status" | "batchQtyMilli">, partRef: string) => ({
	assemblyId: b.id,
	part: partRef,
	code: b.code,
	revision: b.revision,
	status: b.status,
	batchMilli: b.batchQtyMilli,
});

/** Part fields a catalogue tool may set (prices go through prices:write, supplier terms through offers). */
const partFields = {
	name: z.string().max(200).describe('Name, e.g. "Desk lamp".'),
	kind: z
		.enum(PART_KINDS)
		.describe(
			"buy: purchased; make: built from an assembly, stocked; kit: phantom assembly, never stocked; fee: cost only.",
		),
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
		"Changes a part's reference, name, kind, unit, serial tracking or notes; fields left out keep their value. Same checks as the part form (a part with stock moves cannot become a kit or fee, a part with assemblies stays make or kit). Prices and offers are not changed here.",
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
// Assemblies

/** The assembly named by a selector, with its parent part. */
async function selectAssembly(db: Db, sel: z.output<z.ZodObject<typeof assemblySelector>>) {
	return resolveAssembly(db, await loadGraph(db), sel);
}

/** The next free revision label of an assembly's (parent, code), e.g. Rev2 → Rev3. */
async function newRevisionLabel(db: Db, assembly: Assembly): Promise<string> {
	const taken = await db
		.select({ revision: assemblies.revision })
		.from(assemblies)
		.where(and(eq(assemblies.parentPartId, assembly.parentPartId), eq(assemblies.code, assembly.code)));
	return nextRevision(
		assembly.revision,
		taken.map((r) => r.revision),
	);
}

async function linesView(db: Db, assemblyId: number) {
	return (await getAssemblyLines(db, assemblyId)).map((l) => ({
		ref: l.ref,
		qtyMilli: l.qtyMilli,
		notes: l.notes || undefined,
	}));
}

const createAssembly = tool({
	name: "create_assembly",
	title: "Create an assembly",
	description:
		"Creates a draft assembly for a make or kit part, empty or copied from another assembly (same checks as the new assembly form: (code, revision) new for the part, no cycle). Set its lines with set_assembly_lines, then activate it with activate_assembly.",
	rule: { scope: "catalog:write", action: "assemblies.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		part: partRef.describe("Reference of the make or kit part the assembly builds."),
		code: z.string().max(64).default(DEFAULT_CODE).describe(`Variant code (default "${DEFAULT_CODE}").`),
		revision: z.string().max(64).default(DEFAULT_REVISION).describe(`Revision label (default "${DEFAULT_REVISION}").`),
		notes: z.string().max(2000).default(""),
		copy_from: z
			.object(assemblySelector)
			.optional()
			.describe("An assembly to copy the lines from (of this part or another one)."),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.part);
		const source = a.copy_from ? (await selectAssembly(ctx.db, a.copy_from)).assembly : undefined;
		const v = validate(assemblyInput, {
			parent_part_id: String(part.id),
			code: a.code,
			revision: a.revision,
			notes: a.notes,
			copy_from: source ? String(source.id) : "",
		});
		if (!v.ok) refuse(v.errors);
		const d = v.data;
		const errors = await newAssemblyErrors(ctx.db, {
			parentPartId: part.id,
			code: d.code,
			revision: d.revision,
			copyFrom: d.copy_from,
		});
		if (Object.keys(errors).length) refuse(errors, {}, { parent_part_id: "part" });
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.assemblyCreate, { assembly: assemblyLabel(part.ref, d) }),
			createAssemblyStatements(
				ctx.db,
				{ parentPartId: part.id, code: d.code, revision: d.revision, notes: d.notes },
				d.copy_from,
				ctx.user,
				now(),
			),
		);
		const created = await findAssembly(ctx.db, part.id, d.code, d.revision);
		if (!created) throw new Error("created assembly not found");
		return { ...change, assembly: assemblyView(created, part.ref), lines: await linesView(ctx.db, created.id) };
	},
});

const setAssemblyLines = tool({
	name: "set_assembly_lines",
	title: "Set the lines of an assembly",
	description:
		"Replaces all the lines of an assembly at once, in the given order, with the editor's checks on every line (known part, not archived, whole units for serial-tracked parts, no cycle); nothing changes if one line is refused. An active assembly is never edited in place: a new draft revision is created with these lines, and the active one stays as it is until you call activate_assembly on the new revision. Archived assemblies are read-only.",
	rule: { scope: "catalog:write", action: "assemblies.edit" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		...assemblySelector,
		lines: z
			.array(
				z.object({
					ref: partRef.describe("Component part reference."),
					qty: decimal(
						'Quantity per batch of the parent (per unit when its batch is 1), e.g. "2" or "0.5", in the component\'s unit.',
					),
					notes: z.string().max(500).default(""),
				}),
			)
			.min(1)
			.max(500),
	}),
	run: async (a, ctx) => {
		const { assembly, part } = await selectAssembly(ctx.db, a);
		const label = assemblyLabel(part.ref, assembly);
		if (assembly.status === "archived")
			throw new ToolError(
				`Assembly ${label} is archived: ${errorMessage("assembly_archived")} Copy it with new_assembly_revision.`,
			);
		const lines: { componentPartId: number; qtyMilli: number; notes: string }[] = [];
		const problems: string[] = [];
		for (const [i, l] of a.lines.entries()) {
			const at = `line ${i + 1} (${l.ref})`;
			const v = validate(assemblyLineInput, { component: l.ref, qty: formValue(l.qty), notes: l.notes });
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
		if (assembly.status === "active") {
			// The guardrail (D128): the active assembly stays as it is; the lines go on a new draft revision.
			const revision = await newRevisionLabel(ctx.db, assembly);
			const target = { parentPartId: assembly.parentPartId, code: assembly.code, revision };
			const stamp = now();
			const { change } = await saveChange(
				ctx,
				fmt(t.assemblyRevisionLines, { assembly: assemblyLabel(part.ref, target), from: assembly.revision }),
				[
					...createAssemblyStatements(
						ctx.db,
						{ ...target, notes: assembly.notes, production: { batchMilli: assembly.batchQtyMilli } },
						null,
						ctx.user,
						stamp,
					),
					...replaceAssemblyLinesStatements(ctx.db, target, lines, ctx.user, stamp),
				],
			);
			const created = await findAssembly(ctx.db, assembly.parentPartId, assembly.code, revision);
			if (!created) throw new Error("new revision not found");
			return {
				...change,
				assembly: assemblyView(created, part.ref),
				newRevision: true,
				activeAssembly: assemblyView(assembly, part.ref),
				note: `${label} is active and was left unchanged: the lines were set on the new draft revision ${revision}. Call activate_assembly on ${revision} to make builds use it.`,
				lines: await linesView(ctx.db, created.id),
			};
		}
		const { change } = await saveChange(
			ctx,
			fmt(t.assemblyLines, { assembly: label }),
			replaceAssemblyLinesStatements(ctx.db, assembly.id, lines, ctx.user, now()),
		);
		return {
			...change,
			assembly: assemblyView(assembly, part.ref),
			newRevision: false,
			lines: await linesView(ctx.db, assembly.id),
		};
	},
});

const setAssemblyProduction = tool({
	name: "set_assembly_production",
	title: "Set how an assembly is produced",
	description:
		"Sets the production settings of an assembly: batch_qty, how many units of the part one batch makes (e.g. 24 parts per print plate; its lines are then the quantities for the whole batch). Fields left out keep their value. They belong to a revision: a draft is changed in place, an active assembly is never changed (a new draft revision is created with its lines and these settings, to activate with activate_assembly), an archived one is refused.",
	rule: { scope: "catalog:write", action: "assemblies.edit" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		...assemblySelector,
		batch_qty: decimal('Units of the part one batch makes, e.g. "24" (1 = the lines are per unit).').optional(),
	}),
	run: async (a, ctx) => {
		const { assembly, part } = await selectAssembly(ctx.db, a);
		const label = assemblyLabel(part.ref, assembly);
		if (assembly.status === "archived")
			throw new ToolError(
				`Assembly ${label} is archived: ${errorMessage("assembly_archived")} Copy it with new_assembly_revision.`,
			);
		const v = validate(productionInput, {
			batch_qty: a.batch_qty === undefined ? formatQtyInput(assembly.batchQtyMilli) : formValue(a.batch_qty),
		});
		if (!v.ok) refuse(v.errors);
		const production = { batchMilli: v.data.batch_qty };
		if (production.batchMilli === assembly.batchQtyMilli)
			return { ...NOTHING_CHANGED, assembly: assemblyView(assembly, part.ref) };
		const t = ctx.t.history.summaries;
		if (assembly.status === "active") {
			// Production settings belong to the revision (D146): the active assembly stays as it is.
			const revision = await newRevisionLabel(ctx.db, assembly);
			const target = { parentPartId: assembly.parentPartId, code: assembly.code, revision };
			const { change } = await saveChange(
				ctx,
				fmt(t.assemblyRevisionProduction, { assembly: assemblyLabel(part.ref, target), from: assembly.revision }),
				createAssemblyStatements(
					ctx.db,
					{ ...target, notes: assembly.notes, production },
					assembly.id,
					ctx.user,
					now(),
				),
			);
			const created = await findAssembly(ctx.db, assembly.parentPartId, assembly.code, revision);
			if (!created) throw new Error("new revision not found");
			return {
				...change,
				assembly: assemblyView(created, part.ref),
				newRevision: true,
				activeAssembly: assemblyView(assembly, part.ref),
				note: `${label} is active and was left unchanged: the new draft revision ${revision} has its lines and these settings. Call activate_assembly on ${revision} to make builds use it.`,
			};
		}
		const { change } = await saveChange(ctx, fmt(t.assemblyProduction, { assembly: label }), [
			setProductionStatement(ctx.db, assembly.id, production, ctx.user, now()),
		]);
		return {
			...change,
			assembly: { ...assemblyView(assembly, part.ref), batchMilli: production.batchMilli },
			newRevision: false,
		};
	},
});

const newAssemblyRevision = tool({
	name: "new_assembly_revision",
	title: "New assembly revision",
	description:
		"Copies an assembly (any status) into a new draft revision of the same part and variant code (Rev2 → Rev3), as the assembly page's New revision button does. The original is not changed.",
	rule: { scope: "catalog:write", action: "assemblies.edit" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object(assemblySelector),
	run: async (a, ctx) => {
		const { assembly, part } = await selectAssembly(ctx.db, a);
		const revision = await newRevisionLabel(ctx.db, assembly);
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.assemblyRevision, {
				assembly: assemblyLabel(part.ref, { code: assembly.code, revision }),
				from: assembly.revision,
			}),
			createAssemblyStatements(
				ctx.db,
				{ parentPartId: assembly.parentPartId, code: assembly.code, revision, notes: assembly.notes },
				assembly.id,
				ctx.user,
				now(),
			),
		);
		const created = await findAssembly(ctx.db, assembly.parentPartId, assembly.code, revision);
		if (!created) throw new Error("new revision not found");
		return {
			...change,
			assembly: assemblyView(created, part.ref),
			from: assemblyView(assembly, part.ref),
			lines: await linesView(ctx.db, created.id),
		};
	},
});

const activateAssembly = tool({
	name: "activate_assembly",
	title: "Activate an assembly",
	description:
		"Makes a draft or archived assembly the active one of its part and variant code: builds and explosions use it from now on. The previously active revision is archived (and can be activated again later). Give the assembly id or the part with its revision.",
	rule: { scope: "catalog:write", action: "assemblies.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object(assemblySelector),
	run: async (a, ctx: ToolContext) => {
		const { assembly, part } = await selectAssembly(ctx.db, a);
		const label = assemblyLabel(part.ref, assembly);
		if (assembly.status === "active")
			return { ...NOTHING_CHANGED, assembly: assemblyView(assembly, part.ref), note: `${label} is already active.` };
		if (part.kind !== "make" && part.kind !== "kit") refuse({ assembly: "assembly_parent_kind" });
		if (await archivedAssemblyCycles(ctx.db, assembly))
			throw new ToolError(
				`Refused: activating ${label} would create a cycle (one of its parts now contains ${part.ref}).`,
			);
		const previous = await ctx.db
			.select()
			.from(assemblies)
			.where(
				and(
					eq(assemblies.parentPartId, assembly.parentPartId),
					eq(assemblies.code, assembly.code),
					eq(assemblies.status, "active"),
				),
			);
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.assemblyActivate, { assembly: label }),
			activateStatements(ctx.db, assembly, ctx.user, now()),
		);
		return {
			...change,
			assembly: { ...assemblyView(assembly, part.ref), status: "active" },
			archived: previous.map((b) => ({ ...assemblyView(b, part.ref), status: "archived" })),
		};
	},
});

// ---------------------------------------------------------------------------
// catalog:archive (D125): archiving hides a part or assembly and is undone by unarchiving; deleting is never offered.

function archivePartTool(archived: boolean) {
	return tool({
		name: archived ? "archive_part" : "unarchive_part",
		title: archived ? "Archive a part" : "Unarchive a part",
		description: archived
			? "Archives a part: it disappears from lists and pickers (new assembly lines, POs), but its stock, assemblies, builds and history stay. unarchive_part brings it back. Parts are never deleted over MCP."
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

const archiveAssembly = tool({
	name: "archive_assembly",
	title: "Archive an assembly",
	description:
		"Archives an assembly revision: it becomes read-only and is no longer used by builds or explosions (archiving the active one leaves its part and variant without an active assembly until another is activated). activate_assembly can bring it back. Assemblies are never deleted over MCP.",
	rule: { scope: "catalog:archive", action: "assemblies.archive" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object(assemblySelector),
	run: async (a, ctx) => {
		const { assembly, part } = await selectAssembly(ctx.db, a);
		const label = assemblyLabel(part.ref, assembly);
		if (assembly.status === "archived")
			return { ...NOTHING_CHANGED, assembly: assemblyView(assembly, part.ref), note: `${label} is already archived.` };
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.assemblyArchive, { assembly: label }), [
			setAssemblyStatusStatement(ctx.db, assembly.id, "archived", ctx.user, now()),
		]);
		return { ...change, assembly: { ...assemblyView(assembly, part.ref), status: "archived" } };
	},
});

export const CATALOG_TOOLS: readonly ToolSpec[] = [
	createPart,
	updatePart,
	createSupplier,
	updateSupplier,
	createAssembly,
	setAssemblyLines,
	setAssemblyProduction,
	newAssemblyRevision,
	activateAssembly,
	archivePartTool(true),
	archivePartTool(false),
	archiveAssembly,
];
