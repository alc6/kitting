import type { Db } from "../types";
import { listAssemblies } from "./assemblies";
import { listBuilds } from "./builds";
import { listParts } from "./parts";
import { listPos } from "./purchasing";
import { findBin, locationsOf } from "./storage";
import { listSuppliers } from "./suppliers";

/** Rows shown per group on the search page; the group links to its full list. */
export const SEARCH_GROUP_LIMIT = 8;

/**
 * Global search across the catalogue and operations, reusing each list's own filter
 * (parts: ref, name, supplier ref; builds: number, serial, product, component serials; …).
 * Archived and closed records are included: search is for finding anything.
 */
export async function globalSearch(db: Db, q: string) {
	const [parts, assemblies, builds, pos, suppliers] = await Promise.all([
		listParts(db, { q, archived: true }),
		listAssemblies(db, { q, status: "all" }),
		listBuilds(db, { q, status: "all", limit: 200 }),
		listPos(db, { q, status: "all" }),
		listSuppliers(db, q),
	]);
	// Exact reference matches first (typing a full ref is the common case on the shop floor).
	const needle = q.trim().toLowerCase();
	parts.sort((a, b) => Number(b.ref.toLowerCase() === needle) - Number(a.ref.toLowerCase() === needle));
	// Where the shown parts are kept, and the bin the text names when it is one of a drawn unit (D195).
	const [locations, bins] = await Promise.all([
		locationsOf(
			db,
			parts.slice(0, SEARCH_GROUP_LIMIT).map((p) => p.id),
		),
		binsMatching(db, q),
	]);
	return { parts, assemblies, builds, pos, suppliers, locations, bins };
}

export type SearchResults = Awaited<ReturnType<typeof globalSearch>>;

/** The bin "A-2-3" (or level "A-2", or unit "A") of an existing storage unit, read with its chain, as a search result. */
async function binsMatching(db: Db, q: string) {
	const bin = await findBin(db, q);
	return bin ? [bin] : [];
}
