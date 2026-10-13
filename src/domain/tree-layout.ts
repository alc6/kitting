// Left-to-right tree layout for diagrams (the assembly structure diagram). Pure: no I/O, no DOM.
//
// Columns are depths. Leaves take consecutive rows in depth-first order and every parent is
// centred on its first and last visible child, so subtrees occupy disjoint bands of rows and
// no two nodes can overlap. Parts used in several places appear once per use (it is a tree,
// like the exploded assembly), which keeps quantities per branch readable.

export type TreeInput<T> = { data: T; children: TreeInput<T>[] };

export type PlacedNode<T> = {
	/** Index in `nodes`; parents come before their children. */
	id: number;
	parent: number | null;
	data: T;
	depth: number;
	/** Top-left corner. */
	x: number;
	y: number;
	/** Descendants left out by `maxDepth` or `keep` (the node can say "+N more"). */
	hidden: number;
};

export type PlacedEdge = {
	from: number;
	to: number;
	/** SVG path: a horizontal S-curve from the parent's right side to the child's left side. */
	d: string;
	/** Where the child end of the edge is, for a label next to the child. */
	x2: number;
	y2: number;
};

export type TreeLayout<T> = {
	nodes: PlacedNode<T>[];
	edges: PlacedEdge[];
	width: number;
	height: number;
	/** Deepest visible depth (0 for a lone root). */
	depth: number;
};

export type TreeLayoutOptions<T> = {
	nodeWidth: number;
	nodeHeight: number;
	/** Horizontal space between columns. */
	colGap: number;
	/** Vertical space between rows. */
	rowGap: number;
	/** Margin around the drawing. */
	padding: number;
	/** Deepest depth to show (roots are depth 0). Omit to show everything. */
	maxDepth?: number;
	/** Return false to leave a node (and its subtree) out. Roots are always kept. */
	keep?: (data: T) => boolean;
};

function countAll<T>(input: TreeInput<T>): number {
	let n = 1;
	for (const c of input.children) n += countAll(c);
	return n;
}

/** Rounds to 0.5 px so paths stay short and crisp. */
const r = (v: number) => Math.round(v * 2) / 2;

export function layoutTree<T>(roots: TreeInput<T>[], opts: TreeLayoutOptions<T>): TreeLayout<T> {
	const nodes: PlacedNode<T>[] = [];
	const edges: PlacedEdge[] = [];
	const rowStep = opts.nodeHeight + opts.rowGap;
	const colStep = opts.nodeWidth + opts.colGap;
	const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
	let rows = 0;
	let deepest = 0;

	const place = (input: TreeInput<T>, depth: number, parent: number | null): PlacedNode<T> => {
		const node: PlacedNode<T> = { id: nodes.length, parent, data: input.data, depth, x: 0, y: 0, hidden: 0 };
		nodes.push(node);
		deepest = Math.max(deepest, depth);
		const visible: TreeInput<T>[] = [];
		for (const child of input.children) {
			if (depth + 1 > maxDepth || (opts.keep && !opts.keep(child.data))) node.hidden += countAll(child);
			else visible.push(child);
		}
		node.x = opts.padding + depth * colStep;
		if (visible.length === 0) {
			node.y = opts.padding + rows * rowStep;
			rows++;
		} else {
			const placed = visible.map((child) => place(child, depth + 1, node.id));
			node.y = (placed[0]!.y + placed[placed.length - 1]!.y) / 2;
		}
		return node;
	};

	for (const root of roots) place(root, 0, null);

	for (const child of nodes) {
		if (child.parent === null) continue;
		const parent = nodes[child.parent]!;
		const x1 = parent.x + opts.nodeWidth;
		const y1 = parent.y + opts.nodeHeight / 2;
		const x2 = child.x;
		const y2 = child.y + opts.nodeHeight / 2;
		const mx = (x1 + x2) / 2;
		edges.push({
			from: parent.id,
			to: child.id,
			d: `M${r(x1)} ${r(y1)}C${r(mx)} ${r(y1)} ${r(mx)} ${r(y2)} ${r(x2)} ${r(y2)}`,
			x2: r(x2),
			y2: r(y2),
		});
	}

	return {
		nodes,
		edges,
		width: nodes.length ? opts.padding * 2 + (deepest + 1) * colStep - opts.colGap : 0,
		height: nodes.length ? opts.padding * 2 + rows * rowStep - opts.rowGap : 0,
		depth: deepest,
	};
}
