import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../types";

export type Statement = BatchItem<"sqlite">;

/**
 * Runs statements in one D1 batch: a single SQL transaction, so either every statement applies or none does.
 * Returns each statement's result. Writes to tracked tables go through runChangeSet() (src/domain/history.ts),
 * which uses this: a batch writing to them without an open change set is aborted by the history triggers.
 */
export async function runBatch(db: Db, statements: Statement[]): Promise<unknown[]> {
	if (statements.length === 0) return [];
	return db.batch(statements as [Statement, ...Statement[]]);
}
