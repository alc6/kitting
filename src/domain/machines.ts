// Machines (D147–D150). A machine type ("FDM printer") carries the hourly rate that recipes use; machines are what the
// workshop owns, each of a type, with a status. Every rate change is appended to machine_rate_history, which the dated
// readers (valuation "as of", margin history) replay like the price history.
import { and, asc, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	assemblies,
	MACHINE_STATUSES,
	type Machine,
	type MachineStatus,
	type MachineType,
	machineRateHistory,
	machines,
	machineTypes,
	type PriceSource,
	parts,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { formatCentsInput, type NumberLocale } from "../lib/units";
import { field } from "../lib/validation";
import type { Db } from "../types";
import { resolveCostsAt } from "./prices";

export const machineTypeInput = z.object({
	name: field.required(200),
	hourly_rate: field.money(),
	notes: field.text(),
});
export type MachineTypeInput = z.output<typeof machineTypeInput>;

export const machineInput = z.object({
	name: field.required(200),
	machine_type_id: field.id(),
	status: field.oneOf(MACHINE_STATUSES, "invalid_status"),
	notes: field.text(),
});
export type MachineInput = z.output<typeof machineInput>;

export function machineTypeToForm(m: MachineType, locale: NumberLocale = "en"): Record<string, string> {
	return {
		name: m.name,
		hourly_rate: m.hourlyRateCents === null ? "" : formatCentsInput(m.hourlyRateCents, locale),
		notes: m.notes,
	};
}

export function machineToForm(m: Machine): Record<string, string> {
	return { name: m.name, machine_type_id: String(m.machineTypeId), status: m.status, notes: m.notes };
}

// ---------------------------------------------------------------------------
// Reads

/** Machine types with how many machines they have (active, and not retired) and how many recipes use them. */
export async function listMachineTypes(db: Db) {
	return db
		.select({
			id: machineTypes.id,
			name: machineTypes.name,
			hourlyRateCents: machineTypes.hourlyRateCents,
			notes: machineTypes.notes,
			// The outer column is written in full: Drizzle renders \${machineTypes.id} unqualified, which the subquery
			// would read as its own id.
			activeMachines: sql<number>`(SELECT count(*) FROM machines m WHERE m.machine_type_id = machine_types.id AND m.status = 'active')`,
			machineCount: sql<number>`(SELECT count(*) FROM machines m WHERE m.machine_type_id = machine_types.id AND m.status != 'retired')`,
			recipeCount: sql<number>`(SELECT count(*) FROM assemblies b WHERE b.machine_type_id = machine_types.id AND b.status != 'archived' AND b.machine_minutes > 0)`,
		})
		.from(machineTypes)
		.orderBy(asc(machineTypes.name));
}

/** Machines with their type, retired ones only when asked. */
export async function listMachines(db: Db, opts: { retired?: boolean; typeId?: number } = {}) {
	const conds: SQL[] = [];
	if (!opts.retired) conds.push(ne(machines.status, "retired"));
	if (opts.typeId) conds.push(eq(machines.machineTypeId, opts.typeId));
	return db
		.select({
			id: machines.id,
			name: machines.name,
			status: machines.status,
			notes: machines.notes,
			typeId: machineTypes.id,
			typeName: machineTypes.name,
			hourlyRateCents: machineTypes.hourlyRateCents,
		})
		.from(machines)
		.innerJoin(machineTypes, eq(machines.machineTypeId, machineTypes.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(asc(machineTypes.name), asc(machines.name));
}

export async function getMachineType(db: Db, id: number) {
	const rows = await db.select().from(machineTypes).where(eq(machineTypes.id, id)).limit(1);
	return rows[0];
}

export async function getMachine(db: Db, id: number) {
	const rows = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
	return rows[0];
}

/** Case-insensitive lookup by name (forms, CSV and MCP inputs). */
export async function findMachineTypeByName(db: Db, name: string) {
	const rows = await db
		.select()
		.from(machineTypes)
		.where(sql`lower(${machineTypes.name}) = lower(${name.trim()})`)
		.limit(1);
	return rows[0];
}

export async function findMachineByName(db: Db, name: string) {
	const rows = await db.select().from(machines).where(sql`lower(${machines.name}) = lower(${name.trim()})`).limit(1);
	return rows[0];
}

/** Whether another machine type has this name, ignoring case. */
export async function machineTypeNameTaken(db: Db, name: string, exceptId?: number): Promise<boolean> {
	const found = await findMachineTypeByName(db, name);
	return found !== undefined && found.id !== exceptId;
}

/** Whether another machine has this name, ignoring case. */
export async function machineNameTaken(db: Db, name: string, exceptId?: number): Promise<boolean> {
	const found = await findMachineByName(db, name);
	return found !== undefined && found.id !== exceptId;
}

/** Machine types for a select, by name. */
export function machineTypeOptions(db: Db) {
	return db.select({ id: machineTypes.id, name: machineTypes.name }).from(machineTypes).orderBy(asc(machineTypes.name));
}

/** Draft and active assemblies with machine time on this type. */
export function recipesOfType(db: Db, machineTypeId: number) {
	return db
		.select({
			id: assemblies.id,
			code: assemblies.code,
			revision: assemblies.revision,
			status: assemblies.status,
			batchMilli: assemblies.batchQtyMilli,
			machineMinutes: assemblies.machineMinutes,
			partRef: parts.ref,
			partName: parts.name,
			unit: parts.unit,
		})
		.from(assemblies)
		.innerJoin(parts, eq(assemblies.parentPartId, parts.id))
		.where(
			and(
				eq(assemblies.machineTypeId, machineTypeId),
				ne(assemblies.status, "archived"),
				sql`${assemblies.machineMinutes} > 0`,
			),
		)
		.orderBy(asc(parts.ref), asc(assemblies.code), asc(assemblies.revision));
}

/** The hourly rate history of a machine type, newest first. */
export function rateHistoryOf(db: Db, machineTypeId: number) {
	return db
		.select({
			id: machineRateHistory.id,
			rateCents: machineRateHistory.rateCents,
			validFrom: machineRateHistory.validFrom,
			source: machineRateHistory.source,
			note: machineRateHistory.note,
			createdBy: machineRateHistory.createdBy,
		})
		.from(machineRateHistory)
		.where(eq(machineRateHistory.machineTypeId, machineTypeId))
		.orderBy(desc(machineRateHistory.validFrom), desc(machineRateHistory.id))
		.limit(200);
}

/** Hourly rate rows of every machine type, sorted by type, date, id (the dated readers replay them). */
export function machineRateRows(db: Db) {
	return db
		.select({
			machineTypeId: machineRateHistory.machineTypeId,
			rateCents: machineRateHistory.rateCents,
			validFrom: machineRateHistory.validFrom,
		})
		.from(machineRateHistory)
		.orderBy(asc(machineRateHistory.machineTypeId), asc(machineRateHistory.validFrom), asc(machineRateHistory.id));
}

/**
 * Hourly rate of every machine type on a date: the latest history row on or before that day; a type whose history
 * starts later falls back to its earliest row (flagged), as standard costs do (D92).
 */
export async function machineRatesAt(db: Db, date: string) {
	const [rows, current] = await Promise.all([
		machineRateRows(db),
		db.select({ id: machineTypes.id, costCents: machineTypes.hourlyRateCents }).from(machineTypes),
	]);
	return resolveCostsAt(
		rows.map((r) => ({ partId: r.machineTypeId, priceCents: r.rateCents, validFrom: r.validFrom })),
		current,
		date,
	);
}

// ---------------------------------------------------------------------------
// Writes: statements to run in one change set (see runChangeSet in ./history.ts).

/** One rate history row, dated today; `machineType` is an id, or the name of a type created in the same batch. */
export function rateRecordStatement(
	db: Db,
	r: { machineType: number | string; rateCents: number | null; source: PriceSource; note?: string },
	user: string,
	now: string,
) {
	return db.insert(machineRateHistory).values({
		machineTypeId:
			typeof r.machineType === "number"
				? r.machineType
				: sql`(SELECT id FROM machine_types WHERE name = ${r.machineType})`,
		rateCents: r.rateCents,
		validFrom: now.slice(0, 10),
		source: r.source,
		note: r.note ?? "",
		createdBy: user,
		updatedBy: user,
		createdAt: now,
		updatedAt: now,
	});
}

/** Creates (`previous` undefined) or updates a machine type; a rate change is appended to the rate history. */
export function saveMachineTypeStatements(
	db: Db,
	d: MachineTypeInput,
	previous: MachineType | undefined,
	source: PriceSource,
	user: string,
	now: string,
): Statement[] {
	const cols = { name: d.name, hourlyRateCents: d.hourly_rate, notes: d.notes };
	const stmts: Statement[] = previous
		? [
				db
					.update(machineTypes)
					.set({ ...cols, updatedAt: now, updatedBy: user })
					.where(eq(machineTypes.id, previous.id)),
			]
		: [db.insert(machineTypes).values({ ...cols, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now })];
	if (previous ? previous.hourlyRateCents !== d.hourly_rate : d.hourly_rate !== null)
		stmts.push(
			rateRecordStatement(
				db,
				{ machineType: previous ? previous.id : d.name, rateCents: d.hourly_rate, source },
				user,
				now,
			),
		);
	return stmts;
}

/** How many machines a new machine type comes with, set up in the same form (D157): none to 20. */
export const ownedInput = z.object({ owned: field.int() });
export const MAX_OWNED = 20;

/** Names of the machines a new type comes with (D157): the type's name for one, numbered for several. */
export function ownedMachineNames(typeName: string, owned: number): string[] {
	if (owned <= 0) return [];
	if (owned === 1) return [typeName];
	return Array.from({ length: owned }, (_, i) => `${typeName} ${i + 1}`);
}

/** The machines of a type created in the same batch, found by its name (D157), in service. */
export function createOwnedMachineStatements(db: Db, typeName: string, names: string[], user: string, now: string) {
	return names.map((name) =>
		db.insert(machines).values({
			name,
			machineTypeId: sql<number>`(SELECT id FROM machine_types WHERE name = ${typeName})`,
			status: "active",
			notes: "",
			createdBy: user,
			updatedBy: user,
			createdAt: now,
			updatedAt: now,
		}),
	);
}

export function createMachineStatement(db: Db, d: MachineInput, user: string, now: string) {
	return db
		.insert(machines)
		.values({
			name: d.name,
			machineTypeId: d.machine_type_id as number,
			status: d.status,
			notes: d.notes,
			createdBy: user,
			updatedBy: user,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: machines.id });
}

export function updateMachineStatement(db: Db, id: number, d: MachineInput, user: string, now: string) {
	return db
		.update(machines)
		.set({
			name: d.name,
			machineTypeId: d.machine_type_id as number,
			status: d.status,
			notes: d.notes,
			updatedAt: now,
			updatedBy: user,
		})
		.where(eq(machines.id, id));
}

export function setMachineStatusStatement(db: Db, id: number, status: MachineStatus, user: string, now: string) {
	return db.update(machines).set({ status, updatedAt: now, updatedBy: user }).where(eq(machines.id, id));
}

/** Errors of a machine's form beyond its fields: a known type and a name no other machine has. */
export async function machineErrors(db: Db, d: MachineInput, exceptId?: number): Promise<Record<string, string>> {
	const errors: Record<string, string> = {};
	if (!d.machine_type_id || !(await getMachineType(db, d.machine_type_id))) errors.machine_type_id = "required";
	if (await machineNameTaken(db, d.name, exceptId)) errors.name = "duplicate_name";
	return errors;
}
