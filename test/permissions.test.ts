import { describe, expect, it } from "vitest";
import { ROLES } from "../src/db/schema";
import {
	ACTIONS,
	type Action,
	atLeast,
	can,
	PERMISSION_GROUPS,
	PERMISSIONS,
	redactCosts,
	redactCsv,
} from "../src/domain/permissions";
import {
	assemblyId,
	changeSql,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	returnedId,
	setRole,
	stmt,
} from "./helpers";

/** Demo data plus a draft PO, a sent PO and a planned build, as an admin would set them up. */
async function seed() {
	await loadDemo();
	const part = await partId("BOX-LAMP");
	const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE id = ?", part)).id;
	const po = async () => {
		const res = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
		const id = Number(/\/po\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		await postForm(`/purchasing/po/${id}/lines`, { part: "BOX-LAMP", qty: "10", price: "1.00" });
		return id;
	};
	const draft = await po();
	const sent = await po();
	await postForm(`/purchasing/po/${sent}/send`, {});
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", sent)).id;
	const lamp = await partId("LAMP-DESK");
	const assembly = await assemblyId("LAMP-DESK");
	const planned = await postForm("/builds", {
		part_id: String(lamp),
		assembly_id: String(assembly),
		qty: "1",
		serial: "L-1",
		planned_for: "",
		notes: "",
	});
	const build = Number(/\/builds\/(\d+)/.exec(planned.headers.get("Location") ?? "")?.[1]);
	// The change set that planned the build: operators may undo it (they plan builds).
	const planning = (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
	const price = (await one<{ id: number }>("SELECT min(id) AS id FROM price_history WHERE part_id = ?", part)).id;
	// A file attached to the assembly (no R2 object is needed to rename it).
	const [attached] = await changeSql(
		"Attach a file",
		stmt(
			`INSERT INTO files (assembly_id, name, kind, format, size_bytes, sha256, object_key, uploaded_at, uploaded_by,
				created_by, updated_by) VALUES (?, 'guide.pdf', 'instructions', 'pdf', 10, 'abc', 'files/x', '2026-01-01', 'u', 'u', 'u')
				RETURNING id`,
			assembly,
		),
	);
	const file = returnedId(attached);
	return { part, supplier, draft, sent, line, lamp, assembly, build, planning, price, file };
}

type Ids = Awaited<ReturnType<typeof seed>>;
type Call = { method?: "GET" | "POST"; path: string; form?: Record<string, string> };

/** One request per action, performing exactly that action. */
const CALLS: Record<Action, (ids: Ids) => Call> = {
	"parts.edit": () => ({ path: "/parts", form: { ref: "NEW-1", name: "New part", kind: "buy", unit: "pcs" } }),
	"parts.archive": (i) => ({ path: `/parts/${i.part}/archive` }),
	// Used by assemblies and POs: refused with a redirect (in_use), after the permission check.
	"parts.delete": (i) => ({ path: `/parts/${i.part}/delete` }),
	"suppliers.edit": () => ({ path: "/suppliers", form: { name: "Acme", email: "", phone: "", notes: "" } }),
	"suppliers.delete": (i) => ({ path: `/suppliers/${i.supplier}/delete` }),
	"machines.edit": () => ({ path: "/machines/types", form: { name: "Laser cutter", hourly_rate: "", notes: "" } }),
	"files.edit": (i) => ({
		path: `/files/${i.file}`,
		form: { name: "Assembly guide.pdf", kind: "instructions", note: "" },
	}),
	"assemblies.edit": (i) => ({ path: `/assemblies/${i.assembly}/revision` }),
	"assemblies.archive": (i) => ({ path: `/assemblies/${i.assembly}/archive` }),
	// Used by the planned build: refused with a redirect (in_use), after the permission check.
	"assemblies.delete": (i) => ({ path: `/assemblies/${i.assembly}/delete` }),
	"prices.edit": (i) => ({ path: `/assemblies/${i.assembly}/sale-price`, form: { sale_price: "99.00" } }),
	// The only row of its series: refused with a redirect (price_is_current), after the permission check.
	"prices.delete": (i) => ({ path: `/parts/${i.part}/prices/${i.price}/delete` }),
	"builds.plan": (i) => ({
		path: "/builds",
		form: {
			part_id: String(i.lamp),
			assembly_id: String(i.assembly),
			qty: "1",
			serial: "L-2",
			planned_for: "",
			notes: "",
		},
	}),
	"builds.complete": (i) => ({ path: `/builds/${i.build}/complete` }),
	"stock.adjust": () => ({ path: "/stock/adjust", form: { part: "BOX-LAMP", qty: "1", serial: "", note: "found" } }),
	"stock.count": () => ({ path: "/stock/count", form: { "count:BOX-LAMP": "20" } }),
	"purchasing.receive": (i) => ({ path: `/purchasing/po/${i.sent}/receive`, form: { [`recv_${i.line}`]: "1" } }),
	"purchasing.order": (i) => ({ path: `/purchasing/po/${i.draft}/send` }),
	"purchasing.delete": (i) => ({ path: `/purchasing/po/${i.draft}/delete` }),
	"costs.view": () => ({ method: "GET", path: "/margins" }),
	"import.preview": () => ({ path: "/import/suppliers/preview", form: { csv: "name\nAcme\n" } }),
	"import.commit": () => ({ path: "/import/suppliers/commit", form: { csv: "name\nAcme\n" } }),
	"backup.download": () => ({ method: "GET", path: "/import/backup.json" }),
	"backup.restore": () => ({ path: "/import/restore/preview", form: { json: "{}" } }),
	"users.manage": () => ({ path: "/users", form: { email: "new@example.com", role: "operator" } }),
	"history.revert": (i) => ({ path: `/history/${i.planning}/revert` }),
	// MCP connected apps (an unknown grant: the revoke is a no-op that still redirects).
	"apps.connect": () => ({ path: "/connected-apps/unknown-grant/revoke" }),
	"apps.manage": () => ({ path: "/connected-apps/all/unknown-grant/revoke" }),
};

async function send(call: Call) {
	if ((call.method ?? "POST") === "GET") return request(call.path, {}, NOT_ADMIN);
	return postForm(call.path, call.form ?? {}, NOT_ADMIN);
}

describe("permission table", () => {
	it("has one request per action", () => {
		expect(Object.keys(CALLS).sort()).toEqual([...ACTIONS].sort());
	});

	it.each(ACTIONS)("%s: refused just below its role, allowed from it", async (action) => {
		const ids = await seed();
		const min = PERMISSIONS[action].min;
		const below = ROLES[ROLES.indexOf(min) - 1];
		const call = CALLS[action](ids);
		if (below) {
			await setRole(below);
			expect((await send(call)).status, `${below} ${call.path}`).toBe(403);
		}
		await setRole(min);
		const allowed = await send(call);
		expect([200, 303, 422], `${min} ${call.path}: ${allowed.status}`).toContain(allowed.status);
	});

	it("checks roles in order, with costs following the admin option", () => {
		expect(atLeast("admin", "planner")).toBe(true);
		expect(atLeast("operator", "planner")).toBe(false);
		expect(can({ role: "operator", seeCosts: false }, "stock.adjust")).toBe(true);
		expect(can({ role: "operator", seeCosts: false }, "parts.edit")).toBe(false);
		expect(can({ role: "planner", seeCosts: true }, "users.manage")).toBe(false);
		// costs.view is the seeCosts flag computed by resolveAccess (planner and up, or the admin option).
		expect(can({ role: "viewer", seeCosts: true }, "costs.view")).toBe(true);
		expect(can({ role: "admin", seeCosts: false }, "costs.view")).toBe(false);
	});
});

describe("permission groups", () => {
	it("place every action in exactly one group", () => {
		const placed: string[] = PERMISSION_GROUPS.flatMap((g) => [...g.actions]);
		expect([...placed].sort()).toEqual([...ACTIONS].sort());
		expect(new Set(placed).size).toBe(placed.length);
		expect(new Set(PERMISSION_GROUPS.map((g) => g.key)).size).toBe(PERMISSION_GROUPS.length);
	});
});

describe("cost redaction", () => {
	const hidden = { role: "operator", seeCosts: false } as const;
	const shown = { role: "operator", seeCosts: true } as const;

	it("nulls amounts and margin rates in nested data", () => {
		const part = {
			ref: "BOX",
			costCents: 120,
			qtyMilli: 5000,
			offers: [{ supplier: "Acme", priceCents: 110, moqMilli: 100 }],
			margin: { marginCents: 50, rateBp: 2500 },
			rollup: { costMillicents: 120_000, incomplete: false },
		};
		expect(redactCosts(hidden, part)).toEqual({
			ref: "BOX",
			costCents: null,
			qtyMilli: 5000,
			offers: [{ supplier: "Acme", priceCents: null, moqMilli: 100 }],
			margin: { marginCents: null, rateBp: null },
			rollup: { costMillicents: null, incomplete: false },
		});
		expect(redactCosts(shown, part)).toBe(part);
	});

	it("drops money columns from CSV tables", () => {
		const csv = [
			["ref", "qty", "unit_cost", "note", "extended_cost"],
			["BOX", "2", "1.20", "x", "2.40"],
		];
		expect(redactCsv(hidden, csv)).toEqual([
			["ref", "qty", "note"],
			["BOX", "2", "x"],
		]);
		expect(redactCsv(shown, csv)).toBe(csv);
	});
});
