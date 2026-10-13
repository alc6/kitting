// Every MCP tool (D119). Adding a tool = a scope (and a permission action for anything that changes data) in its
// rule + a change set summary for writes + redaction (toWire, automatic on the app's integer fields) + a test.
import { BUILD_TOOLS } from "./build-tools";
import { CATALOG_TOOLS } from "./catalog-tools";
import { HISTORY_TOOLS } from "./history-tools";
import type { ToolSpec } from "./kit";
import { PRICE_TOOLS } from "./price-tools";
import { PURCHASING_TOOLS } from "./purchasing-tools";
import { READ_TOOLS } from "./read-tools";
import { STOCK_TOOLS } from "./stock-tools";

export { READ_ONLY_ANNOTATIONS, type ToolContext, ToolError, type ToolSpec } from "./kit";

/** Every MCP tool, in the order tools/list shows them. */
export const TOOLS: readonly ToolSpec[] = [
	...READ_TOOLS,
	...HISTORY_TOOLS,
	...CATALOG_TOOLS,
	...PRICE_TOOLS,
	...STOCK_TOOLS,
	...BUILD_TOOLS,
	...PURCHASING_TOOLS,
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((t) => [t.name, t]));
