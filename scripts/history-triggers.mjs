// Prints the SQL of the history triggers (D107) from src/db/schema.ts, for a migration:
//   npm run -s db:triggers >> migrations/00NN_name.sql
// Run it after `npm run db:generate` whenever a tracked table (HISTORY_TABLES) gains or loses a column;
// test/history.test.ts fails until the triggers capture every column. Needs Node 22.18+ (type stripping).
const { HISTORY_TABLES, LEDGER_TABLES } = await import("../src/db/schema.ts");
const { historyTriggersSql } = await import("../src/db/history-sql.ts");
process.stdout.write(historyTriggersSql(HISTORY_TABLES, LEDGER_TABLES));
