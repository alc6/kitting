/** Builds a LIKE pattern for a "contains" search; use with `ESCAPE '\'`. */
export function likePattern(q: string): string {
	return `%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** True when a D1 error is a constraint violation (unique / foreign key / check). */
export function isConstraintError(err: unknown, kind?: "UNIQUE" | "FOREIGN KEY" | "CHECK"): boolean {
	const msg = errorMessage(err);
	return kind ? msg.includes(`${kind} constraint failed`) : /constraint failed/i.test(msg);
}

function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	// Drizzle wraps driver errors: look at the cause chain too.
	const cause = (err as { cause?: unknown }).cause;
	return cause ? `${err.message} ${errorMessage(cause)}` : err.message;
}

/** D1 binds at most 100 parameters per statement: split long `IN (…)` lists into chunks of this size. */
export const IN_CHUNK = 90;

export function chunks<T>(list: readonly T[], size = IN_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}
