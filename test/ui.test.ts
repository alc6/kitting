import { describe, expect, it } from "vitest";
import appJs from "../public/static/app.js?raw";
import { insertPart, loadDemo, request } from "./helpers";

function cookieOf(res: Response): string {
	return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

describe("layout and preferences", () => {
	it("renders the sidebar with every section and marks the current one", async () => {
		const html = await (await request("/parts")).text();
		for (const href of [
			"/",
			"/parts",
			"/assemblies",
			"/suppliers",
			"/margins",
			"/builds",
			"/stock",
			"/purchasing",
			"/import",
			"/history",
		]) {
			expect(html).toContain(`href="${href}"`);
		}
		expect(html).toMatch(/href="\/parts" data-slot="sidebar-menu-button" data-active="true"/);
		expect(html).toMatch(/href="\/assemblies" data-slot="sidebar-menu-button" data-active="false"/);
		expect(html).toContain('popover="auto"');
	});

	it("follows the OS theme by default and stores an explicit choice in a cookie", async () => {
		const plain = await (await request("/")).text();
		expect(plain).toMatch(/<html lang="en" data-sidebar="expanded">/);
		expect(plain).toContain('content="light dark"');

		const res = await request("/theme/dark?back=/parts");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/parts");
		const cookie = cookieOf(res);
		expect(cookie).toBe("kitting_theme=dark");
		const dark = await (await request("/parts", { headers: { Cookie: cookie } })).text();
		expect(dark).toContain('class="dark"');
		expect(dark).toMatch(/href="\/theme\/dark\?back=%2Fparts"[^>]*data-state="on"/);

		const light = await (await request("/", { headers: { Cookie: "kitting_theme=light" } })).text();
		expect(light).toContain('class="light"');
		// Unknown values are ignored, and redirects stay on this site.
		expect((await request("/theme/purple")).headers.get("Set-Cookie")).toBeNull();
		const bogus = await (await request("/", { headers: { Cookie: "kitting_theme=purple" } })).text();
		expect(bogus).not.toContain('class="purple"');
		expect((await request("/theme/dark?back=//evil.example.com")).headers.get("Location")).toBe("/");
	});

	it("remembers a collapsed sidebar", async () => {
		const res = await request("/sidebar/collapsed?back=/stock");
		expect(res.headers.get("Location")).toBe("/stock");
		const html = await (await request("/stock", { headers: { Cookie: cookieOf(res) } })).text();
		expect(html).toContain('data-sidebar="collapsed"');
		expect(html).toContain('href="/sidebar/expanded?back=%2Fstock"');
		expect((await request("/sidebar/sideways")).headers.get("Set-Cookie")).toBeNull();
	});

	it("shows a breadcrumb with the section and the page", async () => {
		await loadDemo();
		const html = await (await request("/parts/new")).text();
		expect(html).toMatch(/<a href="\/parts"[^>]*>Parts<\/a>/);
		expect(html).toContain('aria-current="page"');
	});
});

describe("global search", () => {
	it("prompts when empty and finds parts, assemblies and suppliers", async () => {
		const empty = await (await request("/search")).text();
		expect(empty).toContain("A part reference or name");

		await loadDemo();
		const html = await (await request("/search?q=lamp")).text();
		expect(html).toContain("LAMP-DESK");
		expect(html).toMatch(/href="\/parts\/\d+"/);
		expect(html).toMatch(/href="\/assemblies\/\d+"/);

		const supplier = await (await request("/search?q=Ironleaf")).text();
		expect(supplier).toMatch(/href="\/suppliers\/\d+"/);

		const none = await (await request("/search?q=zzzz-nothing")).text();
		expect(none).toContain("Nothing matches “zzzz-nothing”.");
	});

	it("puts an exact reference first", async () => {
		await insertPart("1-PSU");
		await insertPart("PSU");
		const html = await (await request("/search?q=psu")).text();
		const refs = [...html.matchAll(/href="\/parts\/\d+"[^>]*>\s*<span[^>]*>([^<]+)</g)].map((m) => m[1]);
		expect(refs).toEqual(["PSU", "1-PSU"]);
	});
});

describe("UI polish: controls, empty states and filter bars", () => {
	it("shows a short placeholder in the top search box and keeps a descriptive label", async () => {
		const en = await (await request("/parts")).text();
		const input = en.match(/<input[^>]*id="global-search"[^>]*>/)![0];
		expect(input).toContain('placeholder="Search"');
		expect(input).toContain('aria-label="Search parts, assemblies, builds…"');
		const fr = await (await request("/parts", { headers: { Cookie: "kitting_lang=fr" } })).text();
		const frInput = fr.match(/<input[^>]*id="global-search"[^>]*>/)![0];
		expect(frInput).toContain('placeholder="Rechercher"');
		expect(frInput).toContain("aria-label=");
	});

	it("keeps the submit button of a live filter bar for no-JS, marked for app.js to hide", async () => {
		await loadDemo();
		for (const path of ["/parts", "/stock", "/stock/moves", "/suppliers", "/assemblies", "/builds", "/history"]) {
			const html = await (await request(path)).text();
			const form = html.match(/<form[^>]*class="searchbar[\s\S]*?<\/form>/)?.[0] ?? "";
			expect(form, path).toContain('hx-trigger="input delay:300ms, change, submit"');
			expect(form, path).toMatch(/<button[^>]*data-live-submit/);
			expect(form, path).toMatch(/<button[^>]*type="submit"/);
		}
		expect(appJs).toContain("[data-live-submit]");
	});

	it("filters by one compact date range on the change log and the stock moves", async () => {
		for (const path of ["/history", "/stock/moves"]) {
			const html = await (await request(`${path}?from=2026-01-02&to=2026-03-04`)).text();
			const group = html.match(/<fieldset[\s\S]*?<\/fieldset>/)![0];
			expect(group, path).toContain("<legend");
			expect(group, path).toContain("Dates");
			expect(group, path).toMatch(/name="from" value="2026-01-02"/);
			expect(group, path).toMatch(/name="to" value="2026-03-04"/);
		}
	});

	it("adjusts stock from an icon-only ghost button with its own label", async () => {
		await insertPart("PSU");
		const html = await (await request("/stock")).text();
		const link = html.match(/<a[^>]*href="\/stock\/adjust\?part=\d+"[^>]*>[\s\S]*?<\/a>/)![0];
		expect(link).toContain('aria-label="Adjust"');
		expect(link).toContain('title="Adjust"');
		expect(link).toContain("size-(--control-h-sm)");
		expect(link).not.toContain(">Adjust<");
	});

	it("shows a quiet one-line empty state in secondary cards and the full one for a main list", async () => {
		const id = await insertPart("PSU");
		const part = await (await request(`/parts/${id}`)).text();
		expect(part).toContain('data-slot="card-empty"');
		const quiet = part.match(/<p data-slot="card-empty"[\s\S]*?<\/p>/)![0];
		expect(quiet).not.toContain("border-dashed");
		// An empty main list keeps the large empty state.
		const moves = await (await request("/stock/moves?q=zzzz-nothing")).text();
		expect(moves).toContain('data-slot="empty"');
		expect(moves).not.toContain('data-slot="card-empty"');
	});
});
