import type { Db } from "../types";
import { listBoms } from "./boms";
import { listBuilds } from "./builds";
import { listParts } from "./parts";
import { listPos } from "./purchasing";
import { listSuppliers } from "./suppliers";

/** Rows shown per group on the search page; the group links to its full list. */
export const SEARCH_GROUP_LIMIT = 8;

/**
 * Global search across the catalogue and operations, reusing each list's own filter
 * (parts: ref, name, supplier ref; builds: number, serial, product, component serials; …).
 * Archived and closed records are included: search is for finding anything.
 */
export async function globalSearch(db: Db, q: string) {
	const [parts, boms, builds, pos, suppliers] = await Promise.all([
		listParts(db, { q, archived: true }),
		listBoms(db, { q, status: "all" }),
		listBuilds(db, { q, status: "all", limit: 200 }),
		listPos(db, { q, status: "all" }),
		listSuppliers(db, q),
	]);
	// Exact reference matches first (typing a full ref is the common case on the shop floor).
	const needle = q.trim().toLowerCase();
	parts.sort((a, b) => Number(b.ref.toLowerCase() === needle) - Number(a.ref.toLowerCase() === needle));
	return { parts, boms, builds, pos, suppliers };
}

export type SearchResults = Awaited<ReturnType<typeof globalSearch>>;
