import { describe, expect, it } from "vitest";
import { layoutTree, type TreeInput } from "../src/domain/tree-layout";

const OPTS = { nodeWidth: 100, nodeHeight: 40, colGap: 20, rowGap: 10, padding: 5 };

const t = (name: string, ...children: TreeInput<string>[]): TreeInput<string> => ({ data: name, children });

describe("layoutTree", () => {
	it("places a lone root in the corner", () => {
		const out = layoutTree([t("A")], OPTS);
		expect(out.nodes).toEqual([{ id: 0, parent: null, data: "A", depth: 0, x: 5, y: 5, hidden: 0 }]);
		expect(out.edges).toEqual([]);
		expect(out).toMatchObject({ width: 110, height: 50, depth: 0 });
	});

	it("gives each leaf its own row and centres parents on their children", () => {
		const out = layoutTree([t("A", t("B"), t("C", t("D"), t("E")))], OPTS);
		const at = (name: string) => out.nodes.find((n) => n.data === name)!;
		// Rows of 50 px: B=0, D=1, E=2. C centred on D and E, A on B and C.
		expect([at("B").y, at("D").y, at("E").y]).toEqual([5, 55, 105]);
		expect(at("C").y).toBe(80);
		expect(at("A").y).toBe(42.5);
		// Columns of 120 px.
		expect([at("A").x, at("B").x, at("C").x, at("D").x]).toEqual([5, 125, 125, 245]);
		expect(out).toMatchObject({ width: 350, height: 150, depth: 2 });
		// Parents come before children.
		for (const n of out.nodes) if (n.parent !== null) expect(n.parent).toBeLessThan(n.id);
	});

	it("never overlaps nodes, even in uneven trees", () => {
		const deep = t("R", t("a", t("a1", t("a11"), t("a12")), t("a2")), t("b"), t("c", t("c1"), t("c2", t("c21"))));
		const out = layoutTree([deep, t("S", t("s1"))], OPTS);
		for (const a of out.nodes) {
			for (const b of out.nodes) {
				if (a.id >= b.id) continue;
				const apart = Math.abs(a.x - b.x) >= OPTS.nodeWidth || Math.abs(a.y - b.y) >= OPTS.nodeHeight;
				expect(apart, `${a.data} overlaps ${b.data}`).toBe(true);
			}
		}
	});

	it("draws one edge per child, from the parent's right side to the child's left side", () => {
		const out = layoutTree([t("A", t("B"), t("C"))], OPTS);
		expect(out.edges).toHaveLength(2);
		const [ab] = out.edges;
		// A is centred between B (y 5) and C (y 55): its middle is at 30 + 20.
		expect(ab).toEqual({ from: 0, to: 1, d: "M105 50C115 50 115 25 125 25", x2: 125, y2: 25 });
	});

	it("hides nodes below maxDepth and counts them on the last visible ancestor", () => {
		const out = layoutTree([t("A", t("B", t("C", t("D"))), t("E"))], { ...OPTS, maxDepth: 1 });
		expect(out.nodes.map((n) => n.data)).toEqual(["A", "B", "E"]);
		expect(out.nodes.find((n) => n.data === "B")!.hidden).toBe(2);
		expect(out.depth).toBe(1);
	});

	it("leaves out nodes rejected by keep, with their subtrees, but always keeps roots", () => {
		const keep = (name: string) => name !== "x";
		const out = layoutTree([t("x", t("B"), t("x", t("C")))], { ...OPTS, keep });
		expect(out.nodes.map((n) => n.data)).toEqual(["x", "B"]);
		expect(out.nodes[0]!.hidden).toBe(2);
	});
});
