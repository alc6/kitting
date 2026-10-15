import { beforeEach, describe, expect, it } from "vitest";
import { computeShortages } from "../src/domain/purchasing";
import { revertChangeSet } from "../src/domain/revert";
import {
	assemblyId,
	insertPart,
	insertSupplier,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
	TESTER,
	testDb,
} from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

async function planLamps(n: number) {
	for (let i = 1; i <= n; i++) {
		const res = await postForm("/builds", {
			part_id: String(await partId("LAMP-DESK")),
			assembly_id: String(await assemblyId("LAMP-DESK")),
			qty: "1",
			serial: `L-${i}`,
			planned_for: "",
			notes: "",
		});
		expect(res.status).toBe(303);
	}
}

const supplierId = async (name: string) =>
	(await one<{ id: number }>("SELECT id FROM suppliers WHERE name = ?", name)).id;
const poId = (res: Response) => Number(/\/po\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
const lineId = async (po: number, ref: string) =>
	(
		await one<{ id: number }>(
			"SELECT l.id FROM po_lines l JOIN parts p ON p.id = l.part_id WHERE l.po_id = ? AND p.ref = ?",
			po,
			ref,
		)
	).id;
const shortRefs = async () =>
	(await computeShortages(testDb())).groups.flatMap((g) => g.lines.map((l) => l.part.ref)).sort();

describe("draft POs from shortages", () => {
	it("creates one draft PO per checked supplier at standard cost", async () => {
		await loadDemo();
		await planLamps(7);
		expect(await shortRefs()).toEqual(["ARM-TUBE-300", "BASE-PLATE", "DRV-12V", "LED-5W-CW", "PSU-EU-12V"]);
		const page = await (await request("/purchasing")).text();
		expect(page).toContain("Ironleaf Metalworks");
		expect(page).toContain("Lumen Parts Co");
		// One checkbox per supplier inside the form; the header button submits the same form.
		const start = page.indexOf('action="/purchasing/draft-pos"');
		const form = page.slice(start, page.indexOf("</form>", start));
		expect(form).toContain(`name="supplier_${await supplierId("Ironleaf Metalworks")}"`);
		expect(form).toContain(`name="supplier_${await supplierId("Lumen Parts Co")}"`);
		expect(page).toContain('<form id="draft-pos"');
		expect(page).toContain('form="draft-pos"');
		// Only Ironleaf is checked.
		const res = await postForm("/purchasing/draft-pos", {
			[`supplier_${await supplierId("Ironleaf Metalworks")}`]: "on",
		});
		expect(res.headers.get("Location")).toBe("/purchasing/po?created=1");
		const po = await one<{ id: number; number: string; status: string; supplier_id: number; expected_at: string }>(
			"SELECT id, number, status, supplier_id, expected_at FROM purchase_orders",
		);
		expect(po).toMatchObject({
			number: "PO-0001",
			status: "draft",
			supplier_id: await supplierId("Ironleaf Metalworks"),
		});
		expect(po.expected_at).toMatch(/^\d{4}-\d{2}-\d{2}$/); // today + 14 days lead time
		expect(
			await rows(
				"SELECT p.ref, l.qty_milli, l.unit_price_cents FROM po_lines l JOIN parts p ON p.id = l.part_id ORDER BY p.ref",
			),
		).toEqual([
			{ ref: "ARM-TUBE-300", qty_milli: 20_000, unit_price_cents: 240 },
			{ ref: "BASE-PLATE", qty_milli: 10_000, unit_price_cents: 550 },
		]);
		// Drafts count as on order: those shortages are gone, the unchecked supplier's remain.
		expect(await shortRefs()).toEqual(["DRV-12V", "LED-5W-CW", "PSU-EU-12V"]);
		const listed = await (await request("/purchasing/po")).text();
		expect(listed).toContain("PO-0001");
		expect(listed).toContain("€103.00"); // 20 x 2.40 + 10 x 5.50
	});
});

describe("purchase orders", () => {
	async function draftPo(lines: [string, string, string?][]) {
		await loadDemo();
		const res = await postForm("/purchasing/po", {
			supplier_id: String(await supplierId("Lumen Parts Co")),
			expected_at: "",
			notes: "",
		});
		const id = poId(res);
		for (const [part, qty, price] of lines) {
			expect((await postForm(`/purchasing/po/${id}/lines`, { part, qty, price: price ?? "" })).status).toBe(303);
		}
		return id;
	}

	it("edits draft lines, refuses to send an empty PO, then locks lines once sent", async () => {
		await loadDemo();
		const empty = poId(
			await postForm("/purchasing/po", {
				supplier_id: String(await supplierId("Lumen Parts Co")),
				expected_at: "",
				notes: "",
			}),
		);
		expect((await postForm(`/purchasing/po/${empty}/send`, {})).headers.get("Location")).toBe(
			`/purchasing/po/${empty}?err=po_empty`,
		);
		const id = poId(
			await postForm("/purchasing/po", {
				supplier_id: String(await supplierId("Lumen Parts Co")),
				expected_at: "",
				notes: "",
			}),
		);
		await postForm(`/purchasing/po/${id}/lines`, { part: "DIFF-OPAL", qty: "50", price: "" });
		const line = await lineId(id, "DIFF-OPAL");
		expect(await one("SELECT qty_milli, unit_price_cents FROM po_lines WHERE id = ?", line)).toEqual({
			qty_milli: 50_000,
			unit_price_cents: 85,
		});
		await postForm(`/purchasing/po/${id}/lines/${line}`, { qty: "100", price: "0,80" });
		expect(await one("SELECT qty_milli, unit_price_cents FROM po_lines WHERE id = ?", line)).toEqual({
			qty_milli: 100_000,
			unit_price_cents: 80,
		});
		// The editor: htmx swaps #po-lines, which holds the figures too, so they never go stale.
		const editor = await (await request(`/purchasing/po/${id}`)).text();
		const swapped = editor.slice(editor.indexOf('id="po-lines"'), editor.indexOf('id="receive"'));
		expect(swapped).toContain('data-slot="stat"');
		expect(swapped).toContain("€80.00");
		expect(swapped).toContain(`hx-post="/purchasing/po/${id}/lines/${line}"`);
		expect(swapped).toContain('hx-select="#po-lines"');
		expect(swapped).toMatch(/name="qty"[^>]*data-select-on-focus/);
		expect(swapped).toContain(`action="/purchasing/po/${id}/lines/${line}/delete"`);
		expect(swapped).toContain('list="po-parts"');
		expect(editor).toContain(`name="recv_${line}"`);
		expect(editor).toContain(`href="/purchasing/po/${id}/export.csv"`);
		expect(editor).toContain(`action="/purchasing/po/${id}/send"`);
		const bad = await postForm(`/purchasing/po/${id}/lines`, { part: "FEE-WEEE", qty: "1", price: "" });
		expect(await bad.text()).toContain("fee parts are never stocked.");
		await postForm(`/purchasing/po/${id}/send`, {});
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", id)).toEqual({ status: "sent" });
		expect(
			(await postForm(`/purchasing/po/${id}/lines`, { part: "DIFF-OPAL", qty: "1", price: "" })).headers.get(
				"Location",
			),
		).toBe(`/purchasing/po/${id}?err=po_not_draft`);
		const csv = await (await request(`/purchasing/po/${id}/export.csv`)).text();
		expect(csv).toContain("supplier_ref,ref,name,qty,unit,unit_price,line_total");
		expect(csv).toContain("DF60-OP,DIFF-OPAL,Opal diffuser 60mm,100,pcs,0.80,80.00");
	});

	it("receives partially, then fully, posting receipt moves at the PO price", async () => {
		const id = await draftPo([["BOX-LAMP", "10", "1.10"]]);
		await postForm(`/purchasing/po/${id}/send`, {});
		const line = await lineId(id, "BOX-LAMP");
		const before = (
			await one<{ q: number }>(
				"SELECT SUM(qty_milli) AS q FROM stock_moves WHERE part_id = ?",
				await partId("BOX-LAMP"),
			)
		).q;
		await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "4" });
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", id)).toEqual({ status: "partial" });
		expect(await one("SELECT received_qty_milli FROM po_lines WHERE id = ?", line)).toEqual({
			received_qty_milli: 4000,
		});
		expect(
			await one(
				"SELECT qty_milli, reason, ref_type, ref_id, unit_cost_cents, note FROM stock_moves WHERE reason = 'receipt'",
			),
		).toEqual({
			qty_milli: 4000,
			reason: "receipt",
			ref_type: "po",
			ref_id: id,
			unit_cost_cents: 110,
			note: "PO-0001",
		});
		await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "6" });
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", id)).toEqual({ status: "received" });
		const after = (
			await one<{ q: number }>(
				"SELECT SUM(qty_milli) AS q FROM stock_moves WHERE part_id = ?",
				await partId("BOX-LAMP"),
			)
		).q;
		expect(after - before).toBe(10_000);
		// Nothing left to receive.
		expect((await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "1" })).headers.get("Location")).toBe(
			`/purchasing/po/${id}?err=po_not_receivable`,
		);
	});

	it("records one move per received serial and rejects mismatched serial counts", async () => {
		const id = await draftPo([["LED-5W-CW", "3"]]);
		const line = await lineId(id, "LED-5W-CW");
		const bad = await postForm(`/purchasing/po/${id}/receive`, {
			[`recv_${line}`]: "3",
			[`serials_${line}`]: "N1\nN2",
		});
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Enter exactly one serial per unit received (3).");
		expect(await rows("SELECT id FROM stock_moves WHERE reason = 'receipt'")).toEqual([]);
		const dup = await postForm(`/purchasing/po/${id}/receive`, {
			[`recv_${line}`]: "2",
			[`serials_${line}`]: "N1\nN1",
		});
		expect(await dup.text()).toContain("Same serial entered twice.");
		await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "2", [`serials_${line}`]: "N1\nN2" });
		expect(await rows("SELECT serial, qty_milli FROM stock_moves WHERE reason = 'receipt' ORDER BY serial")).toEqual([
			{ serial: "N1", qty_milli: 1000 },
			{ serial: "N2", qty_milli: 1000 },
		]);
		// Receiving a draft marks it sent; the PO is partly received.
		expect(
			await one<{ status: string; sent: number }>(
				"SELECT status, sent_at IS NOT NULL AS sent FROM purchase_orders WHERE id = ?",
				id,
			),
		).toEqual({
			status: "partial",
			sent: 1,
		});
		const empty = await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "" });
		expect(await empty.text()).toContain("Enter a quantity for at least one line.");
	});

	it("closes a short-shipped PO so its remainder is no longer on order", async () => {
		await loadDemo();
		await planLamps(5); // BASE-PLATE short by 2
		const ironleaf = await supplierId("Ironleaf Metalworks");
		await postForm("/purchasing/draft-pos", { [`supplier_${ironleaf}`]: "on" });
		const id = (await one<{ id: number }>("SELECT id FROM purchase_orders")).id;
		await postForm(`/purchasing/po/${id}/send`, {});
		const line = await lineId(id, "BASE-PLATE");
		await postForm(`/purchasing/po/${id}/receive`, { [`recv_${line}`]: "1" }); // 1 of 10 arrives
		expect(await shortRefs()).toEqual([]); // 9 still on order
		expect((await postForm(`/purchasing/po/${id}/cancel`, {})).headers.get("Location")).toBe(
			`/purchasing/po/${id}?err=po_has_receipts`,
		);
		const closed = await postForm(`/purchasing/po/${id}/close`, {});
		expect(closed.headers.get("Location")).toBe(`/purchasing/po/${id}?ok=closed`);
		expect(await (await request(`/purchasing/po/${id}?ok=closed`)).text()).toContain("PO closed.");
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", id)).toEqual({ status: "received" });
		const plate = (await computeShortages(testDb())).groups
			.flatMap((g) => g.lines)
			.find((l) => l.part.ref === "BASE-PLATE");
		expect(plate?.netMilli).toBe(1000); // need 5 - on hand 4
	});

	it("records, edits and removes shipments on sent POs, listed and searchable by tracking number", async () => {
		const id = await draftPo([["BOX-LAMP", "10"]]);
		const shipment = {
			carrier: "Parcel Co",
			tracking_number: "PC123",
			tracking_url: "",
			shipped_at: "",
			shipment_notes: "",
		};
		expect(await (await request(`/purchasing/po/${id}`)).text()).not.toContain('id="shipments"');
		expect((await postForm(`/purchasing/po/${id}/shipments`, shipment)).headers.get("Location")).toBe(
			`/purchasing/po/${id}?err=po_no_shipments`,
		);
		await postForm(`/purchasing/po/${id}/send`, {});

		const bad = await postForm(`/purchasing/po/${id}/shipments`, {
			...shipment,
			carrier: "",
			tracking_url: "javascript:alert(1)",
		});
		expect(bad.status).toBe(422);
		const badHtml = await bad.text();
		expect(badHtml).toContain("Required.");
		expect(badHtml).toContain("Use a link starting with https:// or http://.");

		const added = await postForm(`/purchasing/po/${id}/shipments`, {
			...shipment,
			tracking_url: "https://track.example/PC123",
			shipped_at: "2026-10-14",
		});
		expect(added.headers.get("Location")).toBe(`/purchasing/po/${id}?ok=shipment_saved#shipments`);
		const row = await one<{ id: number }>("SELECT * FROM po_shipments");
		expect(row).toMatchObject({
			po_id: id,
			carrier: "Parcel Co",
			tracking_number: "PC123",
			tracking_url: "https://track.example/PC123",
			shipped_at: "2026-10-14",
		});
		const pageHtml = await (await request(`/purchasing/po/${id}?ok=shipment_saved`)).text();
		expect(pageHtml).toContain("Shipment saved.");
		expect(pageHtml).toContain('href="https://track.example/PC123" target="_blank" rel="noopener noreferrer"');

		const dup = await postForm(`/purchasing/po/${id}/shipments`, { ...shipment, tracking_number: "pc123" });
		expect(dup.status).toBe(422);
		expect(await dup.text()).toContain("This tracking number is already on this PO.");

		const list = await (await request("/purchasing/po")).text();
		expect(list).toContain("Tracking");
		expect(list).toContain("PC123");
		expect(await (await request("/purchasing/po?q=PC12&status=all")).text()).toContain(`href="/purchasing/po/${id}"`);
		expect(await (await request("/search?q=PC123")).text()).toContain(`/purchasing/po/${id}`);

		const edit = await (await request(`/purchasing/po/${id}?shipment=${row.id}`)).text();
		expect(edit).toContain(`action="/purchasing/po/${id}/shipments/${row.id}"`);
		expect(edit).toContain('value="https://track.example/PC123"');
		await postForm(`/purchasing/po/${id}/shipments/${row.id}`, { ...shipment, shipment_notes: "2 boxes" });
		expect(await one("SELECT tracking_url, notes FROM po_shipments")).toEqual({ tracking_url: "", notes: "2 boxes" });

		await setRole("operator");
		expect((await postForm(`/purchasing/po/${id}/shipments`, shipment, NOT_ADMIN)).status).toBe(403);
		const seen = await (await request(`/purchasing/po/${id}`, {}, NOT_ADMIN)).text();
		expect(seen).toContain("PC123");
		expect(seen).not.toContain(`action="/purchasing/po/${id}/shipments"`);
		await setRole("planner");

		const removed = await postForm(`/purchasing/po/${id}/shipments/${row.id}/delete`, {});
		expect(removed.headers.get("Location")).toBe(`/purchasing/po/${id}?ok=shipment_removed#shipments`);
		expect(await rows("SELECT id FROM po_shipments")).toEqual([]);
		const history = await (await request(`/purchasing/po/${id}/history`)).text();
		expect(history).toContain("Remove shipment PC123 from PO");
		expect(history).toContain("Add shipment PC123 to PO");
	});

	it("keeps shipments to their PO and status, one per tracking number ignoring case, undo included", async () => {
		const first = await draftPo([["BOX-LAMP", "10"]]);
		const other = poId(
			await postForm("/purchasing/po", {
				supplier_id: String(await supplierId("Lumen Parts Co")),
				expected_at: "",
				notes: "",
			}),
		);
		await postForm(`/purchasing/po/${other}/lines`, { part: "BOX-LAMP", qty: "5", price: "" });
		for (const id of [first, other]) await postForm(`/purchasing/po/${id}/send`, {});
		const add = (id: number, tracking: string, url = "") =>
			postForm(`/purchasing/po/${id}/shipments`, {
				carrier: "Parcel Co",
				tracking_number: tracking,
				tracking_url: url,
				shipped_at: "",
				shipment_notes: "",
			});
		const shipmentId = async (tracking: string) =>
			(await one<{ id: number }>("SELECT id FROM po_shipments WHERE tracking_number = ?", tracking)).id;

		// The PO's own notes and the shipment's notes are two fields with two ids.
		const page = await (await request(`/purchasing/po/${first}`)).text();
		expect(page.match(/id="f-notes"/g)).toHaveLength(1);
		expect(page.match(/id="f-shipment_notes"/g)).toHaveLength(1);

		expect((await add(first, "AA-1", "http://track.example/AA-1")).status).toBe(303);
		expect((await add(first, "BB-2")).status).toBe(303);
		const bb = await shipmentId("BB-2");
		const renamed = await postForm(`/purchasing/po/${first}/shipments/${bb}`, {
			carrier: "Parcel Co",
			tracking_number: "aa-1",
			tracking_url: "",
			shipped_at: "",
			shipment_notes: "",
		});
		expect(renamed.status).toBe(422);
		expect(await renamed.text()).toContain("This tracking number is already on this PO.");

		// A shipment is reached through its own PO only.
		expect(
			(await postForm(`/purchasing/po/${other}/shipments/${bb}`, { carrier: "X", tracking_number: "X" })).status,
		).toBe(404);
		expect((await postForm(`/purchasing/po/${other}/shipments/${bb}/delete`, {})).status).toBe(404);
		expect(await (await request(`/purchasing/po/${other}?shipment=${bb}`)).text()).not.toContain(`/shipments/${bb}"`);

		// Removed, then entered again in another case: undoing the removal would make two.
		expect((await postForm(`/purchasing/po/${first}/shipments/${bb}/delete`, {})).status).toBe(303);
		const removal = (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
		expect((await add(first, "bb-2")).status).toBe(303);
		const undo = await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, removal, {
			user: TESTER,
			summary: (s) => `Undo #${s.id}: ${s.summary}`,
		});
		expect(undo).toMatchObject({ ok: false, reason: "conflict" });
		expect(await rows("SELECT tracking_number FROM po_shipments WHERE po_id = ? ORDER BY id", first)).toEqual([
			{ tracking_number: "AA-1" },
			{ tracking_number: "bb-2" },
		]);

		// A cancelled PO keeps its shipments, read-only.
		await postForm(`/purchasing/po/${other}/shipments`, {
			carrier: "Parcel Co",
			tracking_number: "CC-3",
			tracking_url: "",
			shipped_at: "",
			shipment_notes: "",
		});
		expect((await postForm(`/purchasing/po/${other}/cancel`, {})).status).toBe(303);
		const cc = await shipmentId("CC-3");
		expect(
			(
				await postForm(`/purchasing/po/${other}/shipments/${cc}`, { carrier: "X", tracking_number: "CC-3" })
			).headers.get("Location"),
		).toBe(`/purchasing/po/${other}?err=po_no_shipments`);
		expect((await postForm(`/purchasing/po/${other}/shipments/${cc}/delete`, {})).headers.get("Location")).toBe(
			`/purchasing/po/${other}?err=po_no_shipments`,
		);
		const cancelled = await (await request(`/purchasing/po/${other}`)).text();
		expect(cancelled).toContain("CC-3");
		expect(cancelled).not.toContain(`action="/purchasing/po/${other}/shipments`);
	});

	it("deletes drafts for admins only", async () => {
		const id = await draftPo([["BOX-LAMP", "1"]]);
		const deleteAction = `action="/purchasing/po/${id}/delete"`;
		expect(await (await request(`/purchasing/po/${id}`, {}, NOT_ADMIN)).text()).not.toContain(deleteAction);
		expect(await (await request(`/purchasing/po/${id}`)).text()).toContain(deleteAction);
		expect((await postForm(`/purchasing/po/${id}/delete`, {}, NOT_ADMIN)).status).toBe(403);
		expect((await postForm(`/purchasing/po/${id}/delete`, {})).headers.get("Location")).toBe(
			"/purchasing/po?ok=deleted",
		);
		expect(await (await request("/purchasing/po?ok=deleted")).text()).toContain("Deleted.");
		expect(await rows("SELECT id FROM po_lines")).toEqual([]);
	});
});

describe("dashboard", () => {
	it("shows shortages, alerts, open POs and builds", async () => {
		await loadDemo();
		await planLamps(5);
		const neg = await insertPart("NEG", "buy", { supplierId: await insertSupplier("Acme") });
		await postForm("/stock/adjust", { part: "NEG", qty: "-2", serial: "", note: "oops" });
		const html = await (await request("/")).text();
		expect(html).toContain("Shortages for planned builds");
		expect(html).toContain("BASE-PLATE");
		expect(html).toContain("Below zero");
		expect(html).toContain(`/parts/${neg}`);
		expect(html).toContain("B-0005");
	});

	it("lists the upcoming builds on one line each, without assembly or serial, and without its own New build button", async () => {
		await loadDemo();
		await planLamps(2);
		const html = await (await request("/")).text();
		const start = html.indexOf("Planned and in-progress builds");
		const card = html.slice(start, html.indexOf("Open POs", start));
		const head = card.slice(card.indexOf("<thead"), card.indexOf("</thead>"));
		for (const label of ["Number", "Quantity", "Status", "Planned for"]) expect(head, label).toContain(label);
		expect(head).not.toContain("Assembly");
		expect(head).not.toContain("Serial");
		expect(card).toContain("LAMP-DESK");
		expect(card).toContain("Modular desk lamp");
		expect(card).not.toContain("std · "); // the assembly code and revision are not shown here
		expect(card).not.toContain("L-1"); // nor the serial number
		// The page header keeps the only New build button.
		expect(html.match(/href="\/builds\/new"/g)).toHaveLength(1);
		// The build pages keep both columns.
		const builds = await (await request("/builds")).text();
		expect(builds).toContain("Assembly");
		expect(builds).toContain("Serial");
		expect(builds).toContain("L-1");
	});
});
