// Storage locations over MCP (D208): one read tool, get_location, for "where is it?" and "what is in there?", read from
// the workshop plan (D194–D200). Kept small on purpose: a part's location is set with update_part, and the plan is
// drawn in the app (no tool draws it, none deletes a unit). get_part returns the part's location as well.
import { z } from "zod";
import type { StorageUnit } from "../db/schema";
import { onHandOf } from "../domain/parts";
import {
	binCode,
	fullCode,
	hasBins,
	holdsParts,
	indexUnits,
	type Location,
	listUnits,
	locate,
	locationCode,
	locationOf,
	locationSortKey,
	nestedIn,
	onPlan,
	parseBin,
	partsInUnits,
	roomOf,
	type ShapedUnit,
	type StoredPart,
	type UnitIndex,
	unitContents,
	unitsInRoom,
	unlocatedParts,
} from "../domain/storage";
import type { Db } from "../types";
import { findPart, limit, ToolError, type ToolSpec, tool } from "./kit";

/**
 * A part's home location as the tools return it: its bin (the code on the label), the whole way to it from the plan
 * (`A-3-3 › S1-2-1`), the room, the unit it is in and the note. Null when the part has none.
 */
export function locationView(l: Location | undefined) {
	if (!l) return null;
	return {
		bin: locationCode(l),
		path: fullCode(l),
		room: l.room,
		storageUnit: { code: l.unit.code, name: l.unit.name, kind: l.unit.kind },
		note: l.note,
	};
}

/** A unit of the plan with the units standing in its bins, as a tree. */
function unitNode(idx: UnitIndex, counts: Map<number, number>, u: StorageUnit, depth = 0): Record<string, unknown> {
	const parent = u.parentUnitId === null ? undefined : idx.get(u.parentUnitId);
	const nested = depth < 8 ? nestedIn(idx, u.id).sort((a, b) => (a.code < b.code ? -1 : 1)) : [];
	return {
		code: u.code,
		name: u.name,
		kind: u.kind,
		...(hasBins(u.kind) ? { levels: u.levels, positions: u.positions } : {}),
		inBin: parent ? binCode(parent.code, u.parentLevel, u.parentPosition) : undefined,
		partCount: counts.get(u.id) ?? 0,
		units: nested.length ? nested.map((k) => unitNode(idx, counts, k, depth + 1)) : undefined,
	};
}

const storedView = (unitCode: string, p: StoredPart) => ({
	ref: p.ref,
	name: p.name,
	bin: binCode(unitCode, p.level, p.position),
	onHandMilli: p.onHandMilli,
	unit: p.unit,
	note: p.note || undefined,
});

/** The whole plan: rooms, the units that hold parts as a tree, and the stocked parts not put away yet. */
async function planView(db: Db, units: ShapedUnit[], counts: Map<number, number>, max: number) {
	const idx = indexUnits(units);
	const unlocated = await unlocatedParts(db);
	const drawn = units.filter((u) => onPlan(u) && holdsParts(u.kind)).sort((a, b) => (a.code < b.code ? -1 : 1));
	return {
		rooms: units
			.filter((u) => u.kind === "room")
			.sort((a, b) => (a.code < b.code ? -1 : 1))
			.map((r) => ({ code: r.code, name: r.name })),
		units: drawn.map((u) => ({ ...unitNode(idx, counts, u), room: roomOf(idx, u.id)?.name ?? null })),
		withoutLocation: unlocated.slice(0, max).map((p) => ({ ref: p.ref, name: p.name })),
		withoutLocationCount: unlocated.length,
		hint: drawn.length
			? undefined
			: "No storage unit is drawn yet: the plan is drawn in the app, on the Locations page.",
	};
}

/** A room: the units in it and every part kept there, in walking order. */
async function roomView(db: Db, idx: UnitIndex, counts: Map<number, number>, room: StorageUnit, max: number) {
	const inside = unitsInRoom(idx, room.id);
	const stored = (await partsInUnits(db, [...inside]))
		.map((p) => {
			const unit = idx.get(p.unitId) as StorageUnit;
			return { part: p, location: locate(idx, unit, p.level, p.position, p.note) };
		})
		.sort((a, b) => {
			const ka = locationSortKey(a.location);
			const kb = locationSortKey(b.location);
			return ka < kb ? -1 : ka > kb ? 1 : a.part.ref < b.part.ref ? -1 : 1;
		});
	// The units drawn in the room, each with the units standing in it.
	const drawn = [...inside]
		.map((id) => idx.get(id) as StorageUnit)
		.filter(onPlan)
		.sort((a, b) => (a.code < b.code ? -1 : 1));
	return {
		place: { kind: "room", code: room.code, name: room.name },
		units: drawn.map((u) => unitNode(idx, counts, u)),
		parts: stored.slice(0, max).map(({ part, location }) => ({
			...storedView(location.unit.code, part),
			path: fullCode(location),
		})),
		partCount: stored.length,
	};
}

/** A unit ("A") or one of its bins ("A-2", "A-2-3"): what it holds, and where it stands. */
async function binView(
	db: Db,
	idx: UnitIndex,
	counts: Map<number, number>,
	unit: StorageUnit,
	level: number | null,
	position: number | null,
	max: number,
) {
	const at = (l: number | null, p: number | null) =>
		(level === null || l === level) && (position === null || p === position);
	const l = locate(idx, unit, level, position);
	const held = (await unitContents(db, unit.id)).filter((p) => at(p.level, p.position));
	const standing = nestedIn(idx, unit.id)
		.filter((u) => at(u.parentLevel, u.parentPosition))
		.sort((a, b) => (a.code < b.code ? -1 : 1));
	return {
		place: {
			kind: level === null ? "unit" : "bin",
			code: locationCode(l),
			path: fullCode(l),
			room: l.room,
			storageUnit: {
				code: unit.code,
				name: unit.name,
				kind: unit.kind,
				...(hasBins(unit.kind) ? { levels: unit.levels, positions: unit.positions } : {}),
			},
		},
		parts: held.slice(0, max).map((p) => storedView(unit.code, p)),
		partCount: held.length,
		units: standing.map((u) => unitNode(idx, counts, u)),
	};
}

const getLocation = tool({
	name: "get_location",
	title: "Where things are kept",
	description:
		'Where parts are kept, on the workshop plan. With a part reference: its location (bin code such as "A-2-3": unit A, level 2 from the floor, position 3 from the left; the path from the plan when its unit stands in another one\'s bin, e.g. "A-3-3 › S1-2-1"; the room; the note). With a bin, unit or room code (or a room\'s name): what it holds (parts with their on-hand quantity, units standing in its bins) and where it is. Without ref: the plan (rooms, the units as a tree with their part counts) and the stocked parts that have no location yet. A part\'s location is set with update_part (location).',
	rule: { scope: "stock:read" },
	input: z.object({
		ref: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe(
				'A part reference ("LED-5W-CW": where is it?), or a bin, unit or room code ("A-2-3", "A-2", "A", "STOC": what does it hold?). A part reference is tried first. Left out: the whole plan.',
			),
		limit: limit(100, 500).describe("Maximum parts to list (default 100, at most 500); part_count gives the total."),
	}),
	run: async (a, { db }) => {
		const rows = await listUnits(db);
		const units = rows.map((r) => r.unit);
		const counts = new Map(rows.map((r) => [r.unit.id, r.partCount]));
		if (a.ref === undefined) return planView(db, units, counts, a.limit);
		const idx = indexUnits(units);

		const part = await findPart(db, a.ref);
		if (part) {
			const [location, onHandMilli] = await Promise.all([locationOf(db, part.id), onHandOf(db, part.id)]);
			return {
				part: { ref: part.ref, name: part.name, kind: part.kind, unit: part.unit, onHandMilli },
				location: locationView(location),
				hint: location
					? undefined
					: units.some((u) => holdsParts(u.kind))
						? "This part has no location yet: set one with update_part (location)."
						: "No plan is drawn yet: units are drawn in the app, on the Locations page.",
			};
		}

		const text = a.ref.trim();
		const room = units.find(
			(u) => u.kind === "room" && (u.code === text.toUpperCase() || u.name.toLowerCase() === text.toLowerCase()),
		);
		if (room) return roomView(db, idx, counts, room, a.limit);

		const bin = parseBin(text);
		const unit = bin ? units.find((u) => u.code === bin.code) : undefined;
		if (!bin || !unit)
			throw new ToolError(
				`Nothing is called "${text}": no part has this reference and no bin, unit or room this code. Use search_parts to find a part, or get_location without ref for the plan and its codes.`,
			);
		if (!holdsParts(unit.kind)) throw new ToolError(`${unit.code} is a ${unit.kind} on the plan: it holds no parts.`);
		const size = hasBins(unit.kind) ? `${unit.levels} level(s) of ${unit.positions} position(s)` : "no levels";
		if (
			(bin.level !== null && (!hasBins(unit.kind) || bin.level < 1 || bin.level > unit.levels)) ||
			(bin.position !== null && (bin.position < 1 || bin.position > unit.positions))
		)
			throw new ToolError(`${unit.code} has ${size}: there is no bin ${binCode(unit.code, bin.level, bin.position)}.`);
		return binView(db, idx, counts, unit, bin.level, bin.position, a.limit);
	},
});

export const LOCATION_TOOLS: readonly ToolSpec[] = [getLocation];
