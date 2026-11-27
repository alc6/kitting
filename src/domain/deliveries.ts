// Customer deliveries (D216): what left the workshop for a customer. A delivery is a header (`deliveries`) and its
// stock moves (reason `delivery`, ref_type `delivery`, negative), written in one change set. Cancelling one posts the
// opposite moves, so its units and serials are back in stock; the ledger itself is never edited.
import { and, asc, desc, eq, exists, inArray, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	changeContext,
	DELIVERY_STATUSES,
	type Delivery,
	type DeliveryStatus,
	deliveries,
	type Part,
	parts,
	stockMoves,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { MILLI, parseMilli } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import type { OptionDef, OptionKey } from "./option-keys";
import { keyValues } from "./option-keys";
import { loadOptions } from "./options";
import { isStocked, moveValues, type NewMove } from "./stock";

export const deliveryInput = z.object({
	customer: field.required(200),
	customer_ref: field.text(100),
	shipped_on: field.date(),
	carrier: field.text(100),
	tracking_number: field.text(100),
	notes: field.text(),
});

export type DeliveryHeader = Pick<
	Delivery,
	"customer" | "customerRef" | "shippedOn" | "carrier" | "trackingNumber" | "notes"
>;

/** The header to save from the form's (or a tool's) values; no date means today (UTC, like every date here). */
export function deliveryHeader(d: z.output<typeof deliveryInput>, now: string): DeliveryHeader {
	return {
		customer: d.customer,
		customerRef: d.customer_ref,
		shippedOn: d.shipped_on ?? now.slice(0, 10),
		carrier: d.carrier,
		trackingNumber: d.tracking_number,
		notes: d.notes,
	};
}

/** The form's values of a saved header (the edit card). */
export function deliveryFormValues(h: DeliveryHeader): Record<string, string> {
	return {
		customer: h.customer,
		customer_ref: h.customerRef,
		shipped_on: h.shippedOn,
		carrier: h.carrier,
		tracking_number: h.trackingNumber,
		notes: h.notes,
	};
}

/** "D-0042" -> next "D-0043" (sequential like builds, D66: the caller retries once on a unique conflict). */
export async function nextDeliveryNumber(db: Db): Promise<string> {
	const rows = await db.select({ number: deliveries.number }).from(deliveries).orderBy(desc(deliveries.id)).limit(20);
	const max = rows.reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.number)?.[1] ?? 0)), 0);
	return `D-${String(max + 1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Lines: what leaves, checked against the stock of each serial.

/** One line asked for, from the form or an MCP tool, with the names its errors go under. */
export type DeliveryLineRequest = {
	fields: { part: string; qty: string; serials: string; option: (o: OptionDef) => string };
	ref: string;
	part: Part | undefined;
	options: OptionDef[];
	/** Raw quantity in the part's unit; empty means one per serial. */
	qty: string;
	serials: string[];
	/** The values chosen for a part with options and no serials (a serial carries its own, D216). */
	chosen: { key: OptionKey; missing: OptionDef | null };
};

/** Serials of a line: newlines, commas or semicolons between them (as on the receive form). */
export const splitSerials = (text: string): string[] =>
	text
		.split(/[\r\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * What each serial of a part has in stock, per option values: SUM(qty_milli) of its moves. A serial is in stock when
 * one of its keys holds a unit; its moves say in which values it was made or received.
 */
export async function serialBalances(
	db: Db,
	partId: number,
	serials: string[],
): Promise<Map<string, { key: OptionKey; qtyMilli: number }[]>> {
	const out = new Map<string, { key: OptionKey; qtyMilli: number }[]>();
	// D1 binds at most 100 parameters per statement.
	for (let i = 0; i < serials.length; i += 90) {
		const chunk = serials.slice(i, i + 90);
		const rows = await db
			.select({
				serial: stockMoves.serial,
				key: stockMoves.optionValues,
				qtyMilli: sql<number>`SUM(${stockMoves.qtyMilli})`,
			})
			.from(stockMoves)
			.where(and(eq(stockMoves.partId, partId), inArray(stockMoves.serial, chunk)))
			.groupBy(stockMoves.serial, stockMoves.optionValues);
		for (const r of rows) {
			if (r.serial === null) continue;
			const list = out.get(r.serial) ?? [];
			list.push({ key: r.key, qtyMilli: Number(r.qtyMilli) });
			out.set(r.serial, list);
		}
	}
	return out;
}

/**
 * The moves of a delivery (negative, valued at each part's standard cost like an adjustment, D52) and the errors of
 * its lines, keyed by each line's own field names. A stocked part is required, with a positive quantity; a part with
 * options needs a value of each; a serial-tracked part needs one serial per unit, each in stock and given once, and
 * leaves in the values that serial is in. Other parts may go below zero (the ledger records reality, D51).
 */
export async function planDelivery(
	db: Db,
	requests: DeliveryLineRequest[],
): Promise<{ moves: NewMove[]; errors: FieldErrors; vars: Record<string, Record<string, string>> }> {
	const errors: FieldErrors = {};
	// The words of each error, per field: two lines can each name their own part (callers translate field by field).
	const vars: Record<string, Record<string, string>> = {};
	const moves: NewMove[] = [];
	const seen = new Set<string>();
	if (requests.length === 0) {
		errors._ = "delivery_empty";
		return { moves, errors, vars };
	}
	for (const r of requests) {
		const { part, fields } = r;
		if (!part) {
			errors[fields.part] = r.ref.trim() ? "unknown_part" : "required";
			vars[fields.part] = { ref: r.ref };
			continue;
		}
		if (!isStocked(part.kind)) {
			errors[fields.part] = "not_stocked";
			vars[fields.part] = { kind: part.kind };
			continue;
		}
		const rawQty = r.qty.trim();
		let qty: number | null = null;
		if (rawQty !== "") {
			qty = parseMilli(rawQty);
			if (qty === null) {
				errors[fields.qty] = "invalid_quantity";
				continue;
			}
			if (qty <= 0) {
				errors[fields.qty] = "not_positive";
				continue;
			}
		}
		if (!part.trackSerial) {
			if (r.serials.length > 0) {
				errors[fields.serials] = "delivery_serial_untracked";
				continue;
			}
			if (qty === null) {
				errors[fields.qty] = "required";
				continue;
			}
			if (r.options.length > 0 && r.chosen.missing) {
				errors[fields.option(r.chosen.missing)] = "option_value_required";
				vars[fields.option(r.chosen.missing)] = { option: r.chosen.missing.name };
				continue;
			}
			moves.push({
				partId: part.id,
				qtyMilli: -qty,
				serial: null,
				unitCostCents: part.costCents,
				optionValues: r.options.length > 0 ? r.chosen.key : null,
			});
			continue;
		}
		// Serial-tracked: one serial per unit, each in stock once.
		if (r.serials.length === 0) {
			errors[fields.serials] = "delivery_serial_required";
			continue;
		}
		if (qty !== null && (qty % MILLI !== 0 || qty / MILLI !== r.serials.length)) {
			errors[fields.serials] = "delivery_serial_count";
			vars[fields.serials] = { n: String(qty / MILLI) };
			continue;
		}
		const duplicate = r.serials.find((s, i) => r.serials.indexOf(s) !== i || seen.has(`${part.id}\n${s}`));
		if (duplicate !== undefined) {
			errors[fields.serials] = "serial_duplicate";
			continue;
		}
		const balances = await serialBalances(db, part.id, r.serials);
		const lineMoves: NewMove[] = [];
		for (const serial of r.serials) {
			seen.add(`${part.id}\n${serial}`);
			const held = (balances.get(serial) ?? []).find((b) => b.qtyMilli >= MILLI);
			if (!held) {
				errors[fields.serials] = "delivery_serial_not_in_stock";
				vars[fields.serials] = { serial, ref: part.ref };
				break;
			}
			lineMoves.push({
				partId: part.id,
				qtyMilli: -MILLI,
				serial,
				unitCostCents: part.costCents,
				optionValues: held.key,
			});
		}
		if (!errors[fields.serials]) moves.push(...lineMoves);
	}
	return { moves, errors, vars };
}

// ---------------------------------------------------------------------------
// Statements (one change set each; the ledger moves make it non-revertible, D111).

const deliveryIdByNumber = (number: string) => sql`(SELECT id FROM deliveries WHERE number = ${number})`;

/** `UPDATE change_context SET conflict = 1 WHERE <cond>`: fails the whole batch (CHECK revert_conflict) when true. */
const guard = (db: Db, condition: SQL) => db.update(changeContext).set({ conflict: 1 }).where(condition);

/** Whether an error is a guard of this module (or revert's) failing its batch. */
export const isGuardError = (err: unknown) => err instanceof Error && /revert_conflict/.test(err.message);

/**
 * A new delivery and its moves, in one batch: the moves reference it by number (it has no id yet). Each serial is
 * checked again inside the batch: if another delivery (or a count) took it since it was planned, the balance of its
 * values goes below zero and the guard fails the batch, which the caller plans again (D216).
 */
export function deliveryStatements(
	db: Db,
	number: string,
	header: DeliveryHeader,
	moves: NewMove[],
	user: string,
	now: string,
): Statement[] {
	const ctx = {
		reason: "delivery" as const,
		refType: "delivery",
		refId: deliveryIdByNumber(number),
		note: number,
		user,
		now,
	};
	return [
		db
			.insert(deliveries)
			.values({ number, ...header, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now })
			.returning({ id: deliveries.id }),
		...moves.map((m) => db.insert(stockMoves).values(moveValues(m, ctx))),
		...moves
			.filter((m) => m.serial !== null)
			.map((m) =>
				guard(
					db,
					sql`(SELECT COALESCE(SUM(qty_milli), 0) FROM stock_moves WHERE part_id = ${m.partId} AND serial = ${m.serial}
						AND option_values IS ${m.optionValues ?? null}) < 0`,
				),
			),
	];
}

/** The header of a shipped delivery (a cancelled one is left alone). */
export function updateDeliveryStatement(db: Db, id: number, header: DeliveryHeader, user: string, now: string) {
	return db
		.update(deliveries)
		.set({ ...header, updatedAt: now, updatedBy: user })
		.where(and(eq(deliveries.id, id), eq(deliveries.status, "shipped")));
}

/**
 * Serials of a shipped delivery that are in stock again (taken back by an adjustment or a count, maybe delivered
 * again since): cancelling would count them twice, so the cancel is refused (D218).
 */
const serialsBackSql = (
	deliveryId: number,
) => sql`SELECT p.ref, d.serial FROM stock_moves d JOIN parts p ON p.id = d.part_id
	WHERE d.ref_type = 'delivery' AND d.ref_id = ${deliveryId} AND d.reason = 'delivery' AND d.qty_milli < 0
		AND d.serial IS NOT NULL
		AND (SELECT SUM(m.qty_milli) FROM stock_moves m WHERE m.part_id = d.part_id AND m.serial = d.serial) > 0`;

export async function serialsBackInStock(db: Db, deliveryId: number): Promise<{ ref: string; serial: string }[]> {
	return db.all<{ ref: string; serial: string }>(serialsBackSql(deliveryId));
}

/**
 * Cancels a shipped delivery: the opposite of each of its moves (same part, values, serial and cost), then the status.
 * Both are guarded by the status, so a second cancel, even one racing this one, changes nothing; a serial in stock
 * again fails the batch (check serialsBackInStock first for a message).
 */
export function cancelDeliveryStatements(
	db: Db,
	delivery: { id: number },
	note: string,
	user: string,
	now: string,
): Statement[] {
	const shipped = sql`EXISTS (SELECT 1 FROM deliveries WHERE id = ${delivery.id} AND status = 'shipped')`;
	return [
		guard(db, sql`${shipped} AND EXISTS (${serialsBackSql(delivery.id)})`),
		db.insert(stockMoves).select(sql`
			SELECT NULL, part_id, -qty_milli, 'delivery', 'delivery', ref_id, serial, unit_cost_cents, ${now}, ${user},
				${note}, ${now}, ${now}, ${user}, ${user}, option_values
			FROM stock_moves
			WHERE ref_type = 'delivery' AND ref_id = ${delivery.id} AND reason = 'delivery' AND qty_milli < 0 AND ${shipped}
			ORDER BY id`),
		db
			.update(deliveries)
			.set({ status: "cancelled", cancelledAt: now, updatedAt: now, updatedBy: user })
			.where(and(eq(deliveries.id, delivery.id), eq(deliveries.status, "shipped"))),
	];
}

// ---------------------------------------------------------------------------
// Queries

export const DELIVERY_FILTERS = ["all", ...DELIVERY_STATUSES] as const;
export type DeliveryFilters = { q?: string; status?: string; limit?: number };

/** A shipped line as pages and tools show it: a part, its values, a quantity and maybe a serial. */
export type DeliveryLine = {
	moveId: number;
	partId: number;
	ref: string;
	name: string;
	unit: string;
	qtyMilli: number;
	serial: string | null;
	optionValues: OptionKey;
	values: string;
	/** The build that made this serial, when it was built here. */
	buildId: number | null;
	buildNumber: string | null;
};

/** The lines of some deliveries: their outgoing moves (a cancellation's moves are not lines), by delivery id. */
export async function deliveryLines(db: Db, ids: number[]): Promise<Map<number, DeliveryLine[]>> {
	const out = new Map<number, DeliveryLine[]>();
	if (ids.length === 0) return out;
	const rows: (Omit<DeliveryLine, "values"> & { deliveryId: number })[] = [];
	// D1 binds at most 100 parameters: a long list (the CSV) reads every delivery line at once and keeps its own.
	const wanted = new Set(ids);
	const chunks = ids.length > 90 ? [null] : [ids];
	for (const chunk of chunks) {
		rows.push(
			...(await db
				.select({
					deliveryId: sql<number>`${stockMoves.refId}`,
					moveId: stockMoves.id,
					partId: parts.id,
					ref: parts.ref,
					name: parts.name,
					unit: parts.unit,
					qtyMilli: sql<number>`-${stockMoves.qtyMilli}`,
					serial: stockMoves.serial,
					optionValues: stockMoves.optionValues,
					buildId: sql<
						number | null
					>`(SELECT b.id FROM builds b WHERE b.part_id = ${stockMoves.partId} AND b.serial = ${stockMoves.serial} AND b.status = 'done' LIMIT 1)`,
					buildNumber: sql<
						string | null
					>`(SELECT b.number FROM builds b WHERE b.part_id = ${stockMoves.partId} AND b.serial = ${stockMoves.serial} AND b.status = 'done' LIMIT 1)`,
				})
				.from(stockMoves)
				.innerJoin(parts, eq(stockMoves.partId, parts.id))
				.where(
					and(
						eq(stockMoves.refType, "delivery"),
						chunk ? inArray(stockMoves.refId, chunk) : undefined,
						eq(stockMoves.reason, "delivery"),
						lt(stockMoves.qtyMilli, 0),
					),
				)
				.orderBy(asc(stockMoves.id))),
		);
	}
	const options = await loadOptions(db, [...new Set(rows.filter((r) => r.optionValues).map((r) => r.partId))]);
	for (const { deliveryId, ...r } of rows) {
		if (!wanted.has(deliveryId)) continue;
		const list = out.get(deliveryId) ?? [];
		list.push({ ...r, values: keyValues(options.get(r.partId) ?? [], r.optionValues) });
		out.set(deliveryId, list);
	}
	return out;
}

function deliveryConditions(f: DeliveryFilters): SQL[] {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		// Also matches what left: a part's reference or name, or a serial ("where did lamp L-0042 go?").
		conds.push(sql`(${deliveries.number} LIKE ${like} ESCAPE '\\' OR ${deliveries.customer} LIKE ${like} ESCAPE '\\'
			OR ${deliveries.customerRef} LIKE ${like} ESCAPE '\\' OR ${deliveries.trackingNumber} LIKE ${like} ESCAPE '\\'
			OR EXISTS (SELECT 1 FROM stock_moves m JOIN parts p ON p.id = m.part_id
				WHERE m.ref_type = 'delivery' AND m.ref_id = ${deliveries.id} AND m.reason = 'delivery'
				AND (m.serial LIKE ${like} ESCAPE '\\' OR p.ref LIKE ${like} ESCAPE '\\' OR p.name LIKE ${like} ESCAPE '\\')))`);
	}
	if (f.status && (DELIVERY_STATUSES as readonly string[]).includes(f.status))
		conds.push(eq(deliveries.status, f.status as DeliveryStatus));
	return conds;
}

/** Deliveries, newest first, with their lines. */
export async function listDeliveries(db: Db, f: DeliveryFilters = {}) {
	const conds = deliveryConditions(f);
	const rows = await db
		.select()
		.from(deliveries)
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(deliveries.shippedOn), desc(deliveries.id))
		.limit(f.limit ?? 500);
	const lines = await deliveryLines(
		db,
		rows.map((r) => r.id),
	);
	return rows.map((d) => ({ delivery: d, lines: lines.get(d.id) ?? [] }));
}

export async function getDelivery(db: Db, id: number) {
	const d = (await db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1))[0];
	if (!d) return undefined;
	return { delivery: d, lines: (await deliveryLines(db, [d.id])).get(d.id) ?? [] };
}

/** A delivery by number, ignoring case ("d-0001"). */
export async function deliveryByNumber(db: Db, number: string) {
	const d = (
		await db
			.select({ id: deliveries.id })
			.from(deliveries)
			.where(sql`lower(${deliveries.number}) = lower(${number.trim()})`)
			.limit(1)
	)[0];
	return d ? getDelivery(db, d.id) : undefined;
}

/** Deliveries that shipped a serial of a part, newest first (normally one; more if one was cancelled and redone). */
export async function deliveriesOfSerial(db: Db, partId: number, serial: string) {
	return db
		.select({
			id: deliveries.id,
			number: deliveries.number,
			customer: deliveries.customer,
			shippedOn: deliveries.shippedOn,
			status: deliveries.status,
		})
		.from(deliveries)
		.where(
			exists(
				db
					.select({ one: sql`1` })
					.from(stockMoves)
					.where(
						and(
							eq(stockMoves.refType, "delivery"),
							eq(stockMoves.refId, deliveries.id),
							eq(stockMoves.reason, "delivery"),
							eq(stockMoves.partId, partId),
							eq(stockMoves.serial, serial),
							lt(stockMoves.qtyMilli, 0),
						),
					),
			),
		)
		.orderBy(desc(deliveries.id));
}

/** Customers already entered, for the form's suggestions. */
export async function knownCustomers(db: Db): Promise<string[]> {
	const rows = await db
		.selectDistinct({ customer: deliveries.customer })
		.from(deliveries)
		.orderBy(asc(deliveries.customer))
		.limit(200);
	return rows.map((r) => r.customer);
}

/** Whether a serial of a part holds a unit in stock (a done build's output not yet delivered, a count…). */
export async function serialInStock(db: Db, partId: number, serial: string): Promise<boolean> {
	const balances = await serialBalances(db, partId, [serial]);
	return (balances.get(serial) ?? []).some((b) => b.qtyMilli >= MILLI);
}
