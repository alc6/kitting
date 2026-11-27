// Customer deliveries (D216): the form, its refusals, the stock it moves, the build page's link, edit and cancel.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parts } from "../src/db/schema";
import {
	cancelDeliveryStatements,
	type DeliveryLineRequest,
	deliveryStatements,
	isGuardError,
	planDelivery,
	updateDeliveryStatement,
} from "../src/domain/deliveries";
import { runChangeSet } from "../src/domain/history";
import {
	assemblyId,
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
import { addOption, adjustViaForm, optionId, valueId } from "./mcp-options-fixture";

/** On-hand of a part: the sum of its moves. */
const onHand = async (ref: string) =>
	(
		await one<{ q: number }>(
			"SELECT COALESCE(SUM(qty_milli), 0) AS q FROM stock_moves WHERE part_id = ?",
			await partId(ref),
		)
	).q;

/** A completed LAMP-DESK build with this serial (its LED and driver serials taken from the demo stock). */
async function completedLamp(serial: string, led = "CW-24-0003", driver = "DRV-7A-101"): Promise<number> {
	const res = await postForm("/builds", {
		part_id: String(await partId("LAMP-DESK")),
		assembly_id: String(await assemblyId("LAMP-DESK")),
		qty: "1",
		serial,
		planned_for: "",
		notes: "",
	});
	expect(res.status).toBe(303);
	const build = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
	const page = await (await request(`/builds/${build}`)).text();
	const ledId = await partId("LED-5W-CW");
	const fields: Record<string, string> = {};
	for (const m of page.matchAll(/name="(serial:(\d+):\d+)"/g))
		fields[m[1] as string] = Number(m[2]) === ledId ? led : driver;
	expect((await postForm(`/builds/${build}/complete`, fields)).status).toBe(303);
	return build;
}

const deliveryId = (res: Response) => Number(/\/deliveries\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);

describe("customer deliveries", () => {
	it("delivers a completed build's serial from its page, and links both ways", async () => {
		await loadDemo();
		const build = await completedLamp("L-0042");
		const buildPage = await (await request(`/builds/${build}`)).text();
		expect(buildPage).toContain(`href="/deliveries/new?build=${build}"`);

		// The form starts from the build: its product and serial.
		const form = await (await request(`/deliveries/new?build=${build}`)).text();
		expect(form).toContain('name="part_1"');
		expect(form).toContain('value="LAMP-DESK"');
		expect(form).toContain(">L-0042</textarea>");

		const lamps = await onHand("LAMP-DESK");
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			customer_ref: "PO-778",
			shipped_on: "2026-11-27",
			carrier: "Parcel Co",
			tracking_number: "TRK-1",
			notes: "Fragile",
			lines: "1",
			part_1: "LAMP-DESK",
			serials_1: "L-0042",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toMatch(/\/deliveries\/\d+\?ok=shipped$/);
		const id = deliveryId(res);
		expect(
			await one("SELECT number, customer, customer_ref, shipped_on, status FROM deliveries WHERE id = ?", id),
		).toEqual({
			number: "D-0001",
			customer: "Acme Retail",
			customer_ref: "PO-778",
			shipped_on: "2026-11-27",
			status: "shipped",
		});
		expect(
			await rows(
				"SELECT qty_milli, reason, ref_type, ref_id, serial, note, by FROM stock_moves WHERE ref_type = 'delivery'",
			),
		).toEqual([
			{
				qty_milli: -1000,
				reason: "delivery",
				ref_type: "delivery",
				ref_id: id,
				serial: "L-0042",
				note: "D-0001",
				by: TESTER,
			},
		]);
		expect(await onHand("LAMP-DESK")).toBe(lamps - 1000);

		// The ledger cannot be undone from the history: the change set says so.
		expect(await one("SELECT summary, revertible FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Deliver D-0001 to Acme Retail",
			revertible: 0,
		});

		const detail = await (await request(`/deliveries/${id}?ok=shipped`)).text();
		expect(detail).toContain("D-0001 · Acme Retail");
		expect(detail).toContain("L-0042");
		expect(detail).toContain(`href="/builds/${build}"`);
		expect(detail).toContain("TRK-1");

		// The build now says where its lamp went, and offers no second delivery.
		const after = await (await request(`/builds/${build}`)).text();
		expect(after).toContain("Delivered to Acme Retail on 2026-11-27");
		expect(after).toContain(`href="/deliveries/${id}"`);
		expect(after).not.toContain(`href="/deliveries/new?build=${build}"`);

		// The list, the moves ledger, the searches and the CSV find it.
		expect(await (await request("/deliveries")).text()).toContain(`href="/deliveries/${id}"`);
		expect(await (await request("/deliveries?q=L-0042")).text()).toContain("D-0001");
		expect(await (await request("/deliveries?q=nobody")).text()).not.toContain("D-0001");
		expect(await (await request("/deliveries?status=cancelled")).text()).not.toContain("D-0001");
		expect(await (await request("/stock/moves?reason=delivery")).text()).toContain(`href="/deliveries/${id}"`);
		expect(await (await request("/search?q=L-0042")).text()).toContain(`href="/deliveries/${id}"`);
		const csv = await (await request("/deliveries?format=csv")).text();
		expect(csv).toContain("D-0001");
		expect(csv).toContain("L-0042");
	});

	it("refuses a serial out of stock, unknown parts and empty forms, keeping what was typed", async () => {
		await loadDemo();
		const refused = async (form: Record<string, string>, ...texts: string[]) => {
			const res = await postForm("/deliveries", { customer: "Acme Retail", lines: "1", ...form });
			expect(res.status, JSON.stringify(form)).toBe(422);
			const body = await res.text();
			for (const text of texts) expect(body).toContain(text);
		};
		await refused(
			{ part_1: "LED-5W-CW", serials_1: "CW-24-0001, NOPE-9" },
			"Serial NOPE-9 of LED-5W-CW is not in stock",
			"CW-24-0001, NOPE-9",
		);
		await refused({ part_1: "LED-5W-CW", qty_1: "1" }, "This part is serial-tracked");
		await refused(
			{ part_1: "LED-5W-CW", qty_1: "3", serials_1: "CW-24-0001" },
			"Enter exactly one serial per unit (3)",
		);
		await refused({ part_1: "PAD-FELT", serials_1: "X-1" }, "This part is not serial-tracked");
		await refused({ part_1: "NOPE", qty_1: "1" }, "Unknown part reference “NOPE”.");
		await refused({ part_1: "HEAD-KIT-CW", qty_1: "1" }, "kit parts are never stocked.");
		await refused({ part_1: "PAD-FELT", qty_1: "0" }, "Must be more than zero.");
		await refused({}, "Enter at least one line");
		await refused({ customer: "", part_1: "PAD-FELT", qty_1: "1" }, "Required.");
		await refused({ part_1: "PAD-FELT", qty_1: "1", shipped_on: "27/11/2026" }, "Use the YYYY-MM-DD format.");
		await refused(
			{ lines: "2", part_1: "LED-5W-CW", serials_1: "CW-24-0001", part_2: "LED-5W-CW", serials_2: "CW-24-0001" },
			"Same serial entered twice.",
		);
		expect(await one("SELECT count(*) AS n FROM deliveries")).toEqual({ n: 0 });
		expect(await one("SELECT count(*) AS n FROM stock_moves WHERE reason = 'delivery'")).toEqual({ n: 0 });
	});

	it("adds lines without saving, and ships several parts in their values, today by default", async () => {
		await loadDemo();
		const more = await postForm("/deliveries/new", { customer: "Acme Retail", lines: "1", part_1: "PAD-FELT" });
		expect(more.status).toBe(200);
		const page = await more.text();
		expect(page).toContain('name="part_2"');
		expect(page).toContain('value="Acme Retail"');
		expect(await one("SELECT count(*) AS n FROM deliveries")).toEqual({ n: 0 });

		// The option selects of a line follow its part (none for a serial-tracked one: a serial has its own values).
		const selects = await (await request("/deliveries/new/options?row=2&part_2=MINI-COVER")).text();
		expect(selects).toContain(`name="opt_2:${await optionId("MINI-COVER")}"`);
		expect(await (await request("/deliveries/new/options?row=1&part_1=LED-5W-CW")).text()).not.toContain("<select");

		await adjustViaForm("MINI-COVER", "5", "black");
		const covers = await onHand("MINI-COVER");
		const felt = await onHand("PAD-FELT");
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			lines: "3",
			part_1: "MINI-COVER",
			qty_1: "2",
			[`opt_1:${await optionId("MINI-COVER")}`]: String(await valueId("MINI-COVER", "black")),
			part_3: "PAD-FELT",
			qty_3: "1,5",
		});
		expect(res.status).toBe(303);
		const id = deliveryId(res);
		expect(await onHand("MINI-COVER")).toBe(covers - 2000);
		expect(await onHand("PAD-FELT")).toBe(felt - 1500);
		const moves = await rows<{ option_values: string | null }>(
			"SELECT option_values FROM stock_moves WHERE ref_type = 'delivery' AND ref_id = ? ORDER BY id",
			id,
		);
		expect(moves).toEqual([{ option_values: String(await valueId("MINI-COVER", "black")) }, { option_values: null }]);
		const d = await one<{ shipped_on: string }>("SELECT shipped_on FROM deliveries WHERE id = ?", id);
		expect(d.shipped_on).toBe(new Date().toISOString().slice(0, 10));
		expect(await (await request(`/deliveries/${id}`)).text()).toContain("black");
	});

	it("ships a serial in the values it is in stock in", async () => {
		await loadDemo();
		const sensor = await partId("LED-5W-WW");
		await addOption(sensor, "Colour", ["white", "black"]);
		await adjustViaForm("LED-5W-WW", "1", "black", "WW-B-1");
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			lines: "1",
			part_1: "LED-5W-WW",
			serials_1: "WW-B-1",
		});
		expect(res.status).toBe(303);
		expect(
			await one(
				"SELECT option_values, serial FROM stock_moves WHERE ref_type = 'delivery' AND ref_id = ?",
				deliveryId(res),
			),
		).toEqual({ option_values: String(await valueId("LED-5W-WW", "black")), serial: "WW-B-1" });
	});

	it("edits the header (undone from the history), and cancels back into stock", async () => {
		await loadDemo();
		const build = await completedLamp("L-0042");
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			shipped_on: "2026-11-27",
			lines: "2",
			part_1: "LAMP-DESK",
			serials_1: "L-0042",
			part_2: "PAD-FELT",
			qty_2: "4",
		});
		const id = deliveryId(res);
		const lamps = await onHand("LAMP-DESK");
		const felt = await onHand("PAD-FELT");

		const edit = await postForm(`/deliveries/${id}`, {
			customer: "Acme Retail SA",
			customer_ref: "",
			shipped_on: "",
			carrier: "Parcel Co",
			tracking_number: "TRK-2",
			notes: "",
		});
		expect(edit.headers.get("Location")).toBe(`/deliveries/${id}?ok=saved`);
		// An emptied date keeps the one recorded; only the header changed, so the change can be undone.
		expect(await one("SELECT customer, shipped_on, tracking_number FROM deliveries WHERE id = ?", id)).toEqual({
			customer: "Acme Retail SA",
			shipped_on: "2026-11-27",
			tracking_number: "TRK-2",
		});
		const set = await one<{ id: number; revertible: number; summary: string }>(
			"SELECT id, revertible, summary FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set).toMatchObject({ revertible: 1, summary: "Edit delivery D-0001" });
		expect((await postForm(`/history/${set.id}/revert`, {})).status).toBe(303);
		expect(await one("SELECT customer FROM deliveries WHERE id = ?", id)).toEqual({ customer: "Acme Retail" });
		expect((await postForm(`/deliveries/${id}`, { customer: "" })).status).toBe(422);

		// Operators ship but do not cancel.
		await setRole("operator");
		expect((await postForm(`/deliveries/${id}/cancel`, {}, NOT_ADMIN)).status).toBe(403);
		expect(await (await request(`/deliveries/${id}`, {}, NOT_ADMIN)).text()).not.toContain(`/deliveries/${id}/cancel`);
		await setRole("planner");
		const cancel = await postForm(`/deliveries/${id}/cancel`, {}, NOT_ADMIN);
		expect(cancel.headers.get("Location")).toBe(`/deliveries/${id}?ok=cancelled`);
		expect(await one("SELECT status FROM deliveries WHERE id = ?", id)).toEqual({ status: "cancelled" });
		expect(await onHand("LAMP-DESK")).toBe(lamps + 1000);
		expect(await onHand("PAD-FELT")).toBe(felt + 4000);
		expect(
			await rows(
				"SELECT qty_milli, serial, note FROM stock_moves WHERE ref_type = 'delivery' AND qty_milli > 0 ORDER BY id",
			),
		).toEqual([
			{ qty_milli: 1000, serial: "L-0042", note: "Cancellation of D-0001" },
			{ qty_milli: 4000, serial: null, note: "Cancellation of D-0001" },
		]);
		// A second cancel changes nothing; a cancelled delivery is no longer edited.
		await postForm(`/deliveries/${id}/cancel`, {}, NOT_ADMIN);
		expect(await onHand("PAD-FELT")).toBe(felt + 4000);
		await postForm(`/deliveries/${id}`, { customer: "Someone else" }, NOT_ADMIN);
		expect(await one("SELECT customer FROM deliveries WHERE id = ?", id)).toEqual({ customer: "Acme Retail" });
		const page = await (await request(`/deliveries/${id}`, {}, NOT_ADMIN)).text();
		expect(page).toContain("Cancelled on");
		expect(page).not.toContain(`action="/deliveries/${id}/cancel"`);

		// The lamp is in stock again: its build offers to deliver it, and says nothing of the cancelled delivery.
		const buildPage = await (await request(`/builds/${build}`, {}, NOT_ADMIN)).text();
		expect(buildPage).toContain(`href="/deliveries/new?build=${build}"`);
		expect(buildPage).not.toContain("Delivered to");
	});

	it("numbers deliveries in sequence and lists the customers already used", async () => {
		await loadDemo();
		for (const customer of ["Acme Retail", "Beta Shops"]) {
			const res = await postForm("/deliveries", { customer, lines: "1", part_1: "PAD-FELT", qty_1: "1" });
			expect(res.status).toBe(303);
		}
		expect(await rows("SELECT number FROM deliveries ORDER BY id")).toEqual([
			{ number: "D-0001" },
			{ number: "D-0002" },
		]);
		const form = await (await request("/deliveries/new")).text();
		expect(form).toContain('<option value="Acme Retail">');
		expect(form).toContain('<option value="Beta Shops">');
	});

	it("names each line's own part in its error", async () => {
		await loadDemo();
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			lines: "2",
			part_1: "NOPE",
			qty_1: "1",
			part_2: "LED-5W-CW",
			serials_2: "NOPE-9",
		});
		expect(res.status).toBe(422);
		const body = await res.text();
		expect(body).toContain("Unknown part reference “NOPE”.");
		expect(body).toContain("Serial NOPE-9 of LED-5W-CW is not in stock");
	});

	it("refuses to cancel a delivery whose serial is in stock again", async () => {
		await loadDemo();
		const res = await postForm("/deliveries", {
			customer: "Acme Retail",
			lines: "1",
			part_1: "LED-5W-CW",
			serials_1: "CW-24-0001",
		});
		const id = deliveryId(res);
		// The LED came back and was put in stock with an adjustment: cancelling would count it twice.
		await adjustViaForm("LED-5W-CW", "1", undefined, "CW-24-0001");
		const leds = await onHand("LED-5W-CW");
		const cancel = await postForm(`/deliveries/${id}/cancel`, {});
		expect(cancel.headers.get("Location")).toBe(`/deliveries/${id}?err=delivery_serial_back_in_stock`);
		expect(await (await request(cancel.headers.get("Location") ?? "")).text()).toContain("is in stock again");
		expect(await one("SELECT status FROM deliveries WHERE id = ?", id)).toEqual({ status: "shipped" });
		expect(await onHand("LED-5W-CW")).toBe(leds);
		// The batch itself refuses it too (a stale read of the delivery).
		const db = testDb();
		await expect(
			runChangeSet(
				db,
				{ user: TESTER, source: "ui", summary: "Cancel" },
				cancelDeliveryStatements(db, { id }, "x", TESTER, "2026-11-27T10:00:00Z"),
			),
		).rejects.toSatisfy(isGuardError);
		expect(await onHand("LED-5W-CW")).toBe(leds);
	});
});

describe("delivery batches, run from stale reads", () => {
	const header = {
		customer: "Acme Retail",
		customerRef: "",
		shippedOn: "2026-11-27",
		carrier: "",
		trackingNumber: "",
		notes: "",
	};
	const now = "2026-11-27T10:00:00.000Z";
	const meta = (summary: string) => ({ user: TESTER, source: "ui" as const, summary });

	async function ledLine(serial: string): Promise<DeliveryLineRequest> {
		const part = (await testDb().select().from(parts).where(eq(parts.ref, "LED-5W-CW")).limit(1))[0];
		return {
			fields: { part: "part", qty: "qty", serials: "serials", option: () => "option" },
			ref: "LED-5W-CW",
			part,
			options: [],
			qty: "",
			serials: [serial],
			chosen: { key: null, missing: null },
		};
	}

	const serialBalance = async (serial: string) =>
		(await one<{ q: number }>("SELECT COALESCE(SUM(qty_milli), 0) AS q FROM stock_moves WHERE serial = ?", serial)).q;

	it("never ships a serial twice: the second batch planned before the first ran is refused whole", async () => {
		await loadDemo();
		const db = testDb();
		// Two requests planned at the same moment: both saw the serial in stock.
		const first = await planDelivery(db, [await ledLine("CW-24-0001")]);
		const second = await planDelivery(db, [await ledLine("CW-24-0001")]);
		expect(first.errors).toEqual({});
		expect(second.errors).toEqual({});
		await runChangeSet(db, meta("First"), deliveryStatements(db, "D-0001", header, first.moves, TESTER, now));
		await expect(
			runChangeSet(db, meta("Second"), deliveryStatements(db, "D-0002", header, second.moves, TESTER, now)),
		).rejects.toSatisfy(isGuardError);
		expect(await serialBalance("CW-24-0001")).toBe(0);
		expect(await rows("SELECT number FROM deliveries")).toEqual([{ number: "D-0001" }]);
		// Planned again, the second request now gets the reason.
		const again = await planDelivery(db, [await ledLine("CW-24-0001")]);
		expect(again.errors).toEqual({ serials: "delivery_serial_not_in_stock" });
		expect(again.vars).toEqual({ serials: { serial: "CW-24-0001", ref: "LED-5W-CW" } });
	});

	it("cancels once and leaves a cancelled delivery's header alone, whatever the caller read", async () => {
		await loadDemo();
		const db = testDb();
		const plan = await planDelivery(db, [await ledLine("CW-24-0002")]);
		await runChangeSet(db, meta("Ship"), deliveryStatements(db, "D-0001", header, plan.moves, TESTER, now));
		const id = (await one<{ id: number }>("SELECT id FROM deliveries WHERE number = 'D-0001'")).id;
		const cancel = () =>
			runChangeSet(db, meta("Cancel"), cancelDeliveryStatements(db, { id }, "Cancellation of D-0001", TESTER, now));
		expect((await cancel()).id).not.toBeNull();
		// A second cancel built from the same stale read: nothing inserted, its empty change set dropped.
		expect((await cancel()).id).toBeNull();
		expect(await one("SELECT count(*) AS n FROM stock_moves WHERE ref_type = 'delivery' AND qty_milli > 0")).toEqual({
			n: 1,
		});
		expect(await serialBalance("CW-24-0002")).toBe(1000);
		const edit = await runChangeSet(db, meta("Edit"), [
			updateDeliveryStatement(db, id, { ...header, customer: "Someone else" }, TESTER, now),
		]);
		expect(edit.id).toBeNull();
		expect(await one("SELECT customer, status FROM deliveries WHERE id = ?", id)).toEqual({
			customer: "Acme Retail",
			status: "cancelled",
		});
	});
});
