// Who has which role, and the admin-set options. Cloudflare Access says who the user is; resolveAccess()
// gives their role (ADMIN_EMAILS, always admin so an admin can never be locked out, then the users table,
// else viewer); what each role may do is in ./permissions.ts.
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ROLES, type Role, settings, users } from "../db/schema";
import { field } from "../lib/validation";
import type { Db } from "../types";
import { type Access, atLeast, PERMISSIONS } from "./permissions";

export function isRole(value: unknown): value is Role {
	return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The "costs.view" rule: from its minimum role on, or for anyone when an admin allows lower roles to see costs. */
export function canSeeCosts(role: Role, lowerRolesSeeCosts: boolean): boolean {
	return atLeast(role, PERMISSIONS["costs.view"].min) || lowerRolesSeeCosts;
}

/** Keys of the `settings` table. A missing row means the default (off). */
export const SETTINGS = { lowerRolesSeeCosts: "lower_roles_see_costs" } as const;

/**
 * The role and cost visibility of a signed-in user, in one query (`email` lower-cased), and whether they are
 * listed: in ADMIN_EMAILS or on the Users page. Unlisted people are viewers in the app, but may not connect an AI
 * assistant nor use one (D130).
 */
export async function resolveAccess(
	db: Db,
	email: string,
	adminEmails: readonly string[],
): Promise<Access & { listed: boolean }> {
	if (adminEmails.includes(email)) return { role: "admin", seeCosts: true, listed: true };
	const rows = await db.all<{ role: string | null; see: string | null }>(sql`
		SELECT (SELECT role FROM users WHERE email = ${email}) AS role,
			(SELECT value FROM settings WHERE key = ${SETTINGS.lowerRolesSeeCosts}) AS see`);
	const stored = rows[0]?.role ?? null;
	const role: Role = isRole(stored) ? stored : "viewer";
	return { role, seeCosts: canSeeCosts(role, rows[0]?.see === "1"), listed: stored !== null };
}

export const userInput = z.object({
	email: field
		.email()
		.refine((v) => v !== "", "required")
		.transform((v) => v.toLowerCase()),
	role: field.oneOf(ROLES),
});
export type UserInput = z.output<typeof userInput>;

export async function listUsers(db: Db) {
	return db.select().from(users).orderBy(asc(users.email));
}

export async function getUser(db: Db, id: number) {
	const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return rows[0];
}

/** Adds a user, or changes the role of the one with this email. */
export function saveUserStatement(db: Db, input: UserInput, user: string, now: string) {
	return db
		.insert(users)
		.values({ ...input, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user })
		.onConflictDoUpdate({ target: users.email, set: { role: input.role, updatedAt: now, updatedBy: user } });
}

export function deleteUserStatement(db: Db, id: number) {
	return db.delete(users).where(eq(users.id, id));
}

export async function lowerRolesSeeCosts(db: Db): Promise<boolean> {
	const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS.lowerRolesSeeCosts)).limit(1);
	return rows[0]?.value === "1";
}

export function setLowerRolesSeeCostsStatement(db: Db, on: boolean, user: string, now: string) {
	const value = on ? "1" : "0";
	return db
		.insert(settings)
		.values({
			key: SETTINGS.lowerRolesSeeCosts,
			value,
			createdAt: now,
			createdBy: user,
			updatedAt: now,
			updatedBy: user,
		})
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now, updatedBy: user } });
}
