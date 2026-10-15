// Shared parts of the MCP tools (D119): the tool shape, input builders and lookups with clear errors. Each tool
// has a scope (and, for tools that change data, a permission action) in its rule, zod input validation with
// decimals parsed by src/lib/units.ts, the existing domain code, and a result in the app's integer fields that
// src/mcp/wire.ts redacts and converts. The tools live in *-tools.ts, listed in ./tools.ts.
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assemblies, builds, type PoShipment, purchaseOrders } from "../db/schema";
import { getAssembly } from "../domain/assemblies";
import { AssemblyCycleError, type AssemblyGraph, defaultAssembly } from "../domain/assembly-graph";
import { getBuild } from "../domain/builds";
import { runChangeSet } from "../domain/history";
import type { ToolRule } from "../domain/mcp-scopes";
import { findRefClash, getPart } from "../domain/parts";
import type { Access } from "../domain/permissions";
import { getPo } from "../domain/purchasing";
import { getChangeSet } from "../domain/revert";
import { type Dict, dict, errorText } from "../i18n";
import type { Statement } from "../lib/db";
import { parseMilli } from "../lib/units";
import type { FieldErrors } from "../lib/validation";
import type { Db } from "../types";

export type ToolContext = {
	db: Db;
	access: Access;
	/** Email of the user the connection acts for: every change is made in their name. */
	user: string;
	/** The OAuth client's name, recorded on every change set it makes. */
	clientName: string;
	/** This deployment's origin, for links to the app. */
	origin: string;
	/** The deployment's default language: change set summaries are written in it, as pages write theirs (D110). */
	t: Dict;
};

export type ToolSpec<S extends z.ZodType = z.ZodType> = {
	name: string;
	title: string;
	description: string;
	rule: ToolRule;
	/** Required for tools that change data (D127); read tools get READ_ONLY_ANNOTATIONS. */
	annotations?: ToolAnnotations;
	input: S;
	/** Data in the app's integer fields (`*Milli`, `*Cents`): toWire() redacts and converts it. */
	run: (args: z.output<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
};

export const tool = <S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec => spec as unknown as ToolSpec;

/** A tool error the model can act on (the SDK returns it as an `isError` result). */
export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Inputs

/** A positive decimal quantity ("2", "1.5", or a number), at most 3 decimals, as milli. */
export const quantity = z
	.union([z.string(), z.number()])
	.transform((v, ctx) => {
		const milli = parseMilli(String(v));
		if (milli === null || milli <= 0) {
			ctx.addIssue({
				code: "custom",
				message: 'must be a positive decimal number with at most 3 decimals, e.g. "2" or "1.5"',
			});
			return z.NEVER;
		}
		return milli;
	})
	.describe('A decimal quantity, e.g. "2" or "0.25" (in the part\'s unit).');

export const limit = (fallback: number, max: number) =>
	z
		.number()
		.int()
		.min(1)
		.max(max)
		.default(fallback)
		.describe(`Maximum rows to return (default ${fallback}, at most ${max}).`);

export const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
	.describe("A date, YYYY-MM-DD (UTC).");

export const partRef = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.describe('A part reference, e.g. "LAMP-DESK" (case-insensitive).');

export const assemblySelector = {
	assembly: z
		.union([z.number().int().positive(), z.string().trim().min(1).max(64)])
		.describe("An assembly id (number), or the reference of the part it builds (string): its active assembly is used."),
	code: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe('Variant code when giving a part reference (default: "std", else its only active assembly).'),
	revision: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe("A specific revision (any status) instead of the active one."),
};

/** Annotations of the tools that only read. */
export const READ_ONLY_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

// ---------------------------------------------------------------------------
// Lookups with clear errors

/** A part by reference, ignoring case, or undefined. */
export async function findPart(db: Db, ref: string) {
	const hit = await findRefClash(db, ref);
	return hit ? await getPart(db, hit.id) : undefined;
}

/** A part by reference, ignoring case; a clear error when there is none. */
export async function partByRef(db: Db, ref: string) {
	const part = await findPart(db, ref);
	if (!part) throw new ToolError(`No part with reference "${ref}". Use search_parts to find it.`);
	return part;
}

export async function resolveAssembly(
	db: Db,
	graph: AssemblyGraph,
	args: { assembly: number | string; code?: string | undefined; revision?: string | undefined },
) {
	if (typeof args.assembly === "number") {
		const found = await getAssembly(db, args.assembly);
		if (!found) throw new ToolError(`No assembly with id ${args.assembly}. Use get_part to list a part's assemblies.`);
		return found;
	}
	const part = await partByRef(db, args.assembly);
	let id: number | undefined;
	if (args.revision) {
		const rows = await db
			.select({ id: assemblies.id })
			.from(assemblies)
			.where(
				and(
					eq(assemblies.parentPartId, part.id),
					eq(assemblies.code, args.code ?? "std"),
					eq(assemblies.revision, args.revision),
				),
			);
		id = rows[0]?.id;
	} else if (args.code) {
		id = [...graph.assemblies.values()].find(
			(b) => b.parentPartId === part.id && b.code === args.code && b.status === "active",
		)?.id;
	} else id = defaultAssembly(graph, part.id)?.id;
	const found = id ? await getAssembly(db, id) : undefined;
	if (!found) {
		const which = args.revision
			? `revision ${args.revision}`
			: args.code
				? `active assembly "${args.code}"`
				: "active assembly";
		throw new ToolError(`${part.ref} has no ${which}. Use get_part to list its assemblies.`);
	}
	return found;
}

/** A build by number (case-insensitive), with its part and assembly. */
export async function buildByNumber(db: Db, number: string) {
	const hit = await db
		.select({ id: builds.id })
		.from(builds)
		.where(sql`lower(${builds.number}) = lower(${number})`)
		.limit(1);
	const found = hit[0] ? await getBuild(db, hit[0].id) : undefined;
	if (!found) throw new ToolError(`No build numbered "${number}". Use list_builds to find it.`);
	return found;
}

/** A purchase order by number (case-insensitive), with its supplier. */
export async function poByNumber(db: Db, number: string) {
	const hit = await db
		.select({ id: purchaseOrders.id })
		.from(purchaseOrders)
		.where(sql`lower(${purchaseOrders.number}) = lower(${number})`)
		.limit(1);
	const found = hit[0] ? await getPo(db, hit[0].id) : undefined;
	if (!found) throw new ToolError(`No purchase order numbered "${number}". Use list_purchase_orders to find it.`);
	return found;
}

/** A PO's shipments as the tools return them (D168). */
export function shipmentViews(shipments: PoShipment[]) {
	return shipments.map((s) => ({
		carrier: s.carrier,
		trackingNumber: s.trackingNumber,
		trackingUrl: s.trackingUrl || undefined,
		shippedAt: s.shippedAt,
		notes: s.notes || undefined,
	}));
}

export function exploding<T>(fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		if (err instanceof AssemblyCycleError)
			throw new ToolError(`This assembly contains a cycle: ${err.refs.join(" → ")}.`);
		throw err;
	}
}

export function refsOf(graph: AssemblyGraph, ids: number[]): string[] {
	return ids.map((id) => graph.parts.get(id)?.ref ?? String(id));
}

// ---------------------------------------------------------------------------
// Writes

/**
 * Annotations of a tool that changes data (D127): destructive when it overwrites, removes or archives existing
 * data or writes the stock ledger (which no undo reverses); idempotent when a second identical call changes
 * nothing more.
 */
export const writes = (o: { destructive: boolean; idempotent: boolean }): ToolAnnotations => ({
	readOnlyHint: false,
	destructiveHint: o.destructive,
	idempotentHint: o.idempotent,
	openWorldHint: false,
});

/** Where a change can be seen and undone, in every write tool's result. */
export type ChangeInfo = {
	/** The change set, or null when nothing changed (no change set is kept then). */
	changeSetId: number | null;
	revertible: boolean;
	/** Only when it can be undone: its page in the app, with the Undo button. */
	historyPath?: string;
	historyUrl?: string;
	undo: string;
};

/** The change part of a result when there was nothing to change (no change set is recorded then). */
export const NOTHING_CHANGED: ChangeInfo = {
	changeSetId: null,
	revertible: false,
	undo: "Nothing changed: no change was recorded.",
};

/**
 * Runs a tool's statements as one change set (D127): in the user's name, source "mcp", with the client's name and
 * `summary` (from the history summaries, never an amount). Returns where to see and undo it, and each statement's
 * result. Ledger writes make the change set non-revertible on their own (trigger), so that is read back.
 */
export async function saveChange<T extends Statement[]>(ctx: ToolContext, summary: string, statements: [...T]) {
	const { id, results } = await runChangeSet(
		ctx.db,
		{ user: ctx.user, source: "mcp", clientName: ctx.clientName, summary },
		statements,
	);
	const set = id === null ? undefined : await getChangeSet(ctx.db, id);
	let change: ChangeInfo;
	if (!set) change = NOTHING_CHANGED;
	else if (set.revertible) {
		const historyPath = `/history/${set.id}`;
		change = {
			changeSetId: set.id,
			revertible: true,
			historyPath,
			historyUrl: `${ctx.origin}${historyPath}`,
			undo: `Recorded as change #${set.id}. The user can undo it from Recent changes in Kitting (${ctx.origin}${historyPath}).`,
		};
	} else {
		change = {
			changeSetId: set.id,
			revertible: false,
			undo: `Recorded as change #${set.id}. Stock and build ledger operations cannot be undone: correct them with reverse movements (adjust_stock).`,
		};
	}
	return { change, results };
}

const EN = dict("en");

/** A validation error key (Dict.errors) as an English sentence for the model. */
export const errorMessage = (key: string, vars: Record<string, string | number> = {}): string =>
	errorText(EN, key, vars);

/**
 * Refuses a write with the same checks' messages as the pages, one line per field: `field: message`. `names` maps
 * form field names to the tool's input names.
 */
export function refuse(
	errors: FieldErrors,
	vars: Record<string, string | number> = {},
	names: Record<string, string> = {},
): never {
	const lines = Object.entries(errors).map(([field, key]) => {
		const name = names[field] ?? field;
		const message = errorMessage(key, vars);
		return field === "_" ? message : `${name}: ${message}`;
	});
	throw new ToolError(`Refused, nothing was changed. ${lines.join(" ")}`);
}

/** A value for a form field, from a tool input: decimals and numbers as text, booleans as "on" or "". */
export function formValue(v: string | number | boolean | null | undefined): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "boolean") return v ? "on" : "";
	return String(v);
}

/**
 * A decimal input (string or number), validated later by the form's own rules. Never empty: a form reads an empty
 * field as "nothing" or 0, which over MCP would silently zero a count or remove a line.
 */
export const decimal = (description: string) =>
	z.union([z.string().trim().min(1, "must not be empty").max(32), z.number()]).describe(description);
