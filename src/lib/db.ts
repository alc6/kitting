import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../types";

export type Statement = BatchItem<"sqlite">;

/**
 * Runs statements in one D1 batch: a single SQL transaction, so either every
 * statement applies or none does.
 */
export async function runBatch(db: Db, statements: Statement[]): Promise<void> {
	if (statements.length === 0) return;
	await db.batch(statements as [Statement, ...Statement[]]);
}
