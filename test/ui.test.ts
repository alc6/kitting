import { describe, expect, it } from "vitest";
import { insertPart, loadDemo, request } from "./helpers";

function cookieOf(res: Response): string {
	return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

describe("layout and preferences", () => {
	it("renders the sidebar with every section and marks the current one", async () => {
		const html = await (await request("/parts")).text();
		for (const href of ["/", "/parts", "/boms", "/suppliers", "/builds", "/stock", "/purchasing", "/import"]) {
			expect(html).toContain(`href="${href}"`);
		}
		expect(html).toMatch(/href="\/parts" data-slot="sidebar-menu-button" data-active="true"/);
		expect(html).toMatch(/href="\/boms" data-slot="sidebar-menu-button" data-active="false"/);
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
	it("prompts when empty and finds parts, BoMs and suppliers", async () => {
		const empty = await (await request("/search")).text();
		expect(empty).toContain("A part reference or name");

		await loadDemo();
		const html = await (await request("/search?q=lamp")).text();
		expect(html).toContain("LAMP-DESK");
		expect(html).toMatch(/href="\/parts\/\d+"/);
		expect(html).toMatch(/href="\/boms\/\d+"/);

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
