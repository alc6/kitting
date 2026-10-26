// Kitting — progressive enhancements. Loaded as an external file (strict CSP:
// no inline scripts). Everything works without JavaScript; this only adds comfort.
(() => {
	// <form data-confirm="Are you sure?"> asks before submitting.
	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement)) return;
		const message = form.dataset.confirm;
		if (message && !window.confirm(message)) event.preventDefault();
	});

	// <input data-select-on-focus> selects its content when tapped (quick quantity entry).
	document.addEventListener("focusin", (event) => {
		const input = event.target;
		if (input instanceof HTMLInputElement && input.dataset.selectOnFocus !== undefined) input.select();
	});

	// <input data-checks="radio-id"> checks that radio when used (the build form's date selects "to make").
	document.addEventListener("focusin", (event) => {
		const input = event.target;
		if (!(input instanceof HTMLElement) || !input.dataset.checks) return;
		const radio = document.getElementById(input.dataset.checks);
		if (radio instanceof HTMLInputElement) radio.checked = true;
	});

	// Preference links (theme, sidebar) are plain GETs that set a cookie and redirect back.
	// With JavaScript, apply the change in place and store the cookie in the background.
	const savePreference = (href) => {
		fetch(href, { credentials: "same-origin", redirect: "manual" }).catch(() => {});
	};

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;
		const themeLink = event.target.closest("a[data-theme-set]");
		if (themeLink instanceof HTMLAnchorElement) {
			event.preventDefault();
			const mode = themeLink.dataset.themeSet;
			const root = document.documentElement;
			root.classList.remove("light", "dark");
			if (mode === "light" || mode === "dark") root.classList.add(mode);
			for (const a of document.querySelectorAll("a[data-theme-set]")) {
				const on = a === themeLink;
				a.dataset.state = on ? "on" : "off";
				if (on) a.setAttribute("aria-current", "true");
				else a.removeAttribute("aria-current");
			}
			savePreference(themeLink.href);
			return;
		}
		const sidebarLink = event.target.closest("a[data-sidebar-toggle]");
		if (sidebarLink instanceof HTMLAnchorElement) {
			event.preventDefault();
			const root = document.documentElement;
			const collapsed = root.dataset.sidebar !== "collapsed";
			root.dataset.sidebar = collapsed ? "collapsed" : "expanded";
			savePreference(sidebarLink.href);
			// The next click must ask for the opposite state.
			sidebarLink.href = sidebarLink.href.replace(
				/\/sidebar\/(collapsed|expanded)/,
				`/sidebar/${collapsed ? "expanded" : "collapsed"}`,
			);
		}
	});

	// Diagrams ([data-diagram]): zoom buttons, Ctrl/Cmd + wheel to zoom, drag to pan with a mouse.
	// Zooming resizes the SVG (its viewBox keeps the drawing); the viewport scrolls.
	for (const root of document.querySelectorAll("[data-diagram]")) {
		const viewport = root.querySelector("[data-diagram-viewport]");
		const svg = viewport?.querySelector("svg");
		const controls = root.querySelector("[data-diagram-controls]");
		if (!(viewport instanceof HTMLElement) || !svg || !(controls instanceof HTMLElement)) continue;
		const baseW = Number(svg.dataset.width);
		const baseH = Number(svg.dataset.height);
		const label = root.querySelector("[data-zoom-level]");
		let scale = 1;
		const setScale = (next, anchorX, anchorY) => {
			const s = Math.min(2.5, Math.max(0.2, next));
			// Keep the point under the cursor (or the centre) in place.
			const ax = anchorX ?? viewport.clientWidth / 2;
			const ay = anchorY ?? viewport.clientHeight / 2;
			const px = (viewport.scrollLeft + ax) / scale;
			const py = (viewport.scrollTop + ay) / scale;
			scale = s;
			svg.setAttribute("width", String(Math.round(baseW * s)));
			svg.setAttribute("height", String(Math.round(baseH * s)));
			viewport.scrollLeft = px * s - ax;
			viewport.scrollTop = py * s - ay;
			if (label) label.textContent = `${Math.round(s * 100)}%`;
		};
		const widthFit = () => (viewport.clientWidth - 2) / baseW;
		const fitAll = () => setScale(Math.min(1, widthFit(), (viewport.clientHeight - 2) / baseH));
		controls.hidden = false;
		controls.addEventListener("click", (event) => {
			const button = event.target instanceof Element ? event.target.closest("[data-zoom]") : null;
			if (!(button instanceof HTMLElement)) return;
			const action = button.dataset.zoom;
			if (action === "in") setScale(scale * 1.25);
			else if (action === "out") setScale(scale / 1.25);
			else if (action === "reset") setScale(1);
			else if (action === "fit") fitAll();
		});
		viewport.addEventListener(
			"wheel",
			(event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				const rect = viewport.getBoundingClientRect();
				setScale(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
			},
			{ passive: false },
		);
		let drag = null;
		viewport.addEventListener("pointerdown", (event) => {
			if (event.pointerType !== "mouse" || event.button !== 0) return;
			drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
		});
		viewport.addEventListener("pointermove", (event) => {
			if (!drag) return;
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
			if (!drag.moved) viewport.setPointerCapture(event.pointerId);
			drag.moved = true;
			viewport.dataset.dragging = "true";
			viewport.scrollLeft = drag.left - dx;
			viewport.scrollTop = drag.top - dy;
		});
		const endDrag = () => {
			if (drag?.moved) {
				// Swallow the click that ends a drag, so dropping on a box does not open it.
				const swallow = (e) => e.preventDefault();
				viewport.addEventListener("click", swallow, { capture: true, once: true });
				setTimeout(() => viewport.removeEventListener("click", swallow, { capture: true }), 0);
			}
			drag = null;
			delete viewport.dataset.dragging;
		};
		viewport.addEventListener("pointerup", endDrag);
		viewport.addEventListener("pointercancel", endDrag);
		// Wide diagrams start fitted to the width (tall ones scroll, so the text stays readable).
		if (baseW > viewport.clientWidth) setScale(Math.min(1, widthFit()));
		// Tall diagrams start scrolled to the root (the product), centred vertically.
		const rootNode = svg.querySelector('[data-mode="root"]');
		if (rootNode) {
			const r = rootNode.getBoundingClientRect();
			const s = svg.getBoundingClientRect();
			viewport.scrollTop = r.top - s.top + r.height / 2 - viewport.clientHeight / 2;
		}
	}

	// The value of a form's field by name: a text input, a select, or a group of radios (RadioNodeList).
	const fieldValue = (form, name) => {
		const el = form.elements.namedItem(name);
		return el && "value" in el ? String(el.value) : "";
	};

	// <div data-show-if="kind:rack,cabinet|placement:plan">: shown only while one of its conditions holds (a field of its
	// form has one of the listed values). Without JavaScript everything stays visible and the server ignores what does
	// not apply.
	for (const form of document.querySelectorAll("form")) {
		const parts = [...form.querySelectorAll("[data-show-if]")];
		if (parts.length === 0) continue;
		const update = () => {
			for (const el of parts) {
				const show = el.dataset.showIf.split("|").some((cond) => {
					const [name, values] = cond.split(":");
					return values.split(",").includes(fieldValue(form, name));
				});
				el.hidden = !show;
			}
		};
		form.addEventListener("change", update);
		update();
	}

	// Room outlines (D212, D214): corners [x, y] in squares ("x,y x,y …" in a form), walls along the grid, clockwise on
	// screen. Shared by the room editor of the unit form and the plan editor board.
	const parseOutline = (text) => {
		const pts = (text ?? "")
			.trim()
			.split(/\s+/)
			.map((g) => g.split(",").map(Number));
		return pts.length >= 4 && pts.every((p) => p.length === 2 && p.every(Number.isInteger)) ? pts : null;
	};
	const outlineText = (p) => p.map((q) => q.join(",")).join(" ");
	const outlineArea = (p) =>
		p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;
	// Drops repeated and in-line corners, and turns the outline clockwise on screen (the room on the right).
	const normOutline = (pts) => {
		const p = pts.map((q) => [q[0], q[1]]);
		for (let again = true; again && p.length >= 4; ) {
			again = false;
			for (let i = 0; i < p.length; i++) {
				const a = p[(i + p.length - 1) % p.length];
				const b = p[i];
				const c = p[(i + 1) % p.length];
				if ((b[0] === c[0] && b[1] === c[1]) || (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) {
					p.splice(i, 1);
					again = true;
					break;
				}
			}
		}
		if (outlineArea(p) < 0) p.reverse();
		return p;
	};
	// Walls along the grid that never cross or touch but at their ends, inside `limit` ({ w, h } in squares).
	const validOutline = (p, limit) => {
		const n = p.length;
		if (n < 4 || outlineArea(p) <= 0) return false;
		const walls = [];
		for (let i = 0; i < n; i++) {
			const a = p[i];
			const b = p[(i + 1) % n];
			if ((a[0] !== b[0]) === (a[1] !== b[1])) return false;
			if (a[0] < 0 || a[1] < 0 || a[0] > limit.w || a[1] > limit.h) return false;
			walls.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
		}
		for (let i = 0; i < n; i++)
			for (let j = i + 2; j < n; j++) {
				if (i === 0 && j === n - 1) continue;
				const e = walls[i];
				const f = walls[j];
				if (e[0] <= f[2] && f[0] <= e[2] && e[1] <= f[3] && f[1] <= e[3]) return false;
			}
		return true;
	};
	const outlineBox = (p) => {
		const xs = p.map((q) => q[0]);
		const ys = p.map((q) => q[1]);
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
	};
	// Presets fill a box: an L keeps the top and the left, a T a bar and a stem, a U two arms.
	const OUTLINE_PRESETS = {
		rect: ({ x, y, w, h }) => [
			[x, y],
			[x + w, y],
			[x + w, y + h],
			[x, y + h],
		],
		L: ({ x, y, w, h }) => {
			const a = Math.ceil(h / 2);
			const b = Math.ceil(w / 2);
			return [
				[x, y],
				[x + w, y],
				[x + w, y + a],
				[x + b, y + a],
				[x + b, y + h],
				[x, y + h],
			];
		},
		T: ({ x, y, w, h }) => {
			const a = Math.ceil(h / 2);
			const s = Math.max(1, Math.round(w / 3));
			const sx = x + Math.floor((w - s) / 2);
			return [
				[x, y],
				[x + w, y],
				[x + w, y + a],
				[sx + s, y + a],
				[sx + s, y + h],
				[sx, y + h],
				[sx, y + a],
				[x, y + a],
			];
		},
		U: ({ x, y, w, h }) => {
			const c = Math.max(1, Math.round(w / 3));
			const g = Math.ceil(h / 2);
			return [
				[x, y],
				[x + c, y],
				[x + c, y + g],
				[x + w - c, y + g],
				[x + w - c, y],
				[x + w, y],
				[x + w, y + h],
				[x, y + h],
			];
		},
	};
	// The outline `from` with wall `drag.wall` pushed, or corner `drag.corner` moved, by (dx, dy) squares: a wall moves
	// across its own line, a corner drags the two walls that meet there. Not checked.
	const dragOutline = (from, drag, dx, dy) => {
		const q = from.map((v) => v.slice());
		const n = q.length;
		if (drag.wall !== undefined) {
			const a = q[drag.wall];
			const b = q[(drag.wall + 1) % n];
			if (a[1] === b[1]) {
				a[1] += dy;
				b[1] += dy;
			} else {
				a[0] += dx;
				b[0] += dx;
			}
		} else {
			const v = q[drag.corner];
			const prev = q[(drag.corner + n - 1) % n];
			const next = q[(drag.corner + 1) % n];
			const oy = v[1];
			v[0] += dx;
			v[1] += dy;
			if (prev[1] === oy) prev[1] = v[1];
			else prev[0] = v[0];
			if (next[1] === oy) next[1] = v[1];
			else next[0] = v[0];
		}
		return normOutline(q);
	};
	// A step cut into wall `i`: its second half moves into the room by `depth` squares, less when that would not fit.
	// Null when the wall is too short or no step fits.
	const cutOutline = (poly, i, depth, limit) => {
		const n = poly.length;
		const a = poly[i];
		const b = poly[(i + 1) % n];
		const flat = a[1] === b[1];
		const len = Math.abs(flat ? b[0] - a[0] : b[1] - a[1]);
		const sx = Math.sign(b[0] - a[0]);
		const sy = Math.sign(b[1] - a[1]);
		const m = flat ? [a[0] + sx * Math.floor(len / 2), a[1]] : [a[0], a[1] + sy * Math.floor(len / 2)];
		for (let d = depth; len >= 2 && d >= 1; d--) {
			const inward = [-sy * d, sx * d];
			const r = normOutline([
				...poly.slice(0, i + 1),
				m,
				[m[0] + inward[0], m[1] + inward[1]],
				[b[0] + inward[0], b[1] + inward[1]],
				...poly.slice(i + 1),
			]);
			if (validOutline(r, limit)) return r;
		}
		return null;
	};

	// The handles of a room's outline: one in the middle of each wall ([data-wall]) and one on each corner
	// ([data-corner]), sized in screen pixels (k: drawing units per pixel), with the length of the selected or moving
	// walls. `add(tag, attrs, parent)` creates an SVG element.
	const wallHandles = (add, poly, sq, k, coarse, layer, selected, moving, metres, squareCm) => {
		const n = poly.length;
		for (let i = 0; i < n; i++) {
			const a = poly[i];
			const b = poly[(i + 1) % n];
			const flat = a[1] === b[1];
			const mx = ((a[0] + b[0]) / 2) * sq;
			const my = ((a[1] + b[1]) / 2) * sq;
			const g = add("g", { "data-wall": i, class: flat ? "cursor-ns-resize" : "cursor-ew-resize" }, layer);
			const line = { x1: a[0] * sq, y1: a[1] * sq, x2: b[0] * sq, y2: b[1] * sq };
			if (i === selected) add("line", { ...line, "stroke-width": 4, class: "stroke-plan-accent" }, g);
			add("line", { ...line, "stroke-width": coarse ? 32 : 16, class: "stroke-transparent" }, g);
			const long = 18 * k;
			const thin = 6 * k;
			add(
				"rect",
				{
					x: mx - (flat ? long : thin) / 2,
					y: my - (flat ? thin : long) / 2,
					width: flat ? long : thin,
					height: flat ? thin : long,
					rx: thin / 2,
					"stroke-width": 1.5,
					class: i === selected ? "fill-plan-accent stroke-plan-accent" : "fill-background stroke-plan-accent",
				},
				g,
			);
			if (i === selected || moving(i)) {
				const len = Math.abs(flat ? b[0] - a[0] : b[1] - a[1]);
				const label = add(
					"text",
					{
						x: mx + (flat ? 0 : 14 * k),
						y: my + (flat ? -12 * k : 4 * k),
						"text-anchor": flat ? "middle" : "start",
						class: "pointer-events-none fill-plan-accent text-[11px] font-medium tabular-nums",
					},
					layer,
				);
				label.textContent = `${metres.format((len * squareCm) / 100)} m`;
			}
		}
		for (let i = 0; i < n; i++) {
			const g = add("g", { "data-corner": i, class: "cursor-move" }, layer);
			const c = { cx: poly[i][0] * sq, cy: poly[i][1] * sq };
			add("circle", { ...c, r: (coarse ? 24 : 12) * k, class: "fill-transparent" }, g);
			add("circle", { ...c, r: 5 * k, "stroke-width": 1.5, class: "fill-background stroke-plan-accent" }, g);
		}
	};

	// Plan editor (<svg data-plan-editor data-form="…">, D198): the unit being edited ([data-editing]) follows the form's
	// fields as they change, and dragging it (or its corner handle) moves (or resizes) it in whole squares and fills the
	// fields. A room's other rectangles (D211) are more [data-editing] shapes whose fields carry their data-prefix
	// ("area2_col"…). Without JavaScript the fields alone place the unit.
	for (const svg of document.querySelectorAll("svg[data-plan-editor]")) {
		const form = document.getElementById(svg.dataset.form ?? "");
		const shapes = [...svg.querySelectorAll("[data-editing]")];
		if (!(form instanceof HTMLFormElement) || shapes.length === 0) continue;
		// data-square: SVG units of one square (not always a whole number); data-square-cm: its real size.
		const sq = Number(svg.dataset.square) || 24;
		const squareCm = Number(svg.dataset.squareCm) || 50;
		const metres = new Intl.NumberFormat(document.documentElement.lang || undefined, {
			maximumFractionDigits: 2,
			useGrouping: false,
		});
		const read = (name, min) => {
			const n = Number.parseInt(fieldValue(form, name), 10);
			return Number.isFinite(n) ? Math.max(min, n) : min;
		};
		const write = (name, value) => {
			const el = form.elements.namedItem(name);
			if (el instanceof HTMLInputElement) el.value = String(value);
		};
		const set = (el, attrs) => {
			for (const [k, v] of Object.entries(attrs)) el?.setAttribute(k, String(v));
		};
		const parts = shapes.map((g) => ({
			group: g,
			prefix: g.getAttribute("data-prefix") ?? "",
			shape: g.querySelector("[data-shape]"),
			front: g.querySelector("[data-front]"),
			code: g.querySelector("[data-code]"),
			size: g.querySelector("[data-size]"),
			handle: g.querySelector("[data-handle]"),
		}));
		const draw = () => {
			const kind = fieldValue(form, "kind");
			for (const p of parts) {
				const f = (side) => p.prefix + side;
				// A room's areas only show while the form is for a room.
				if (p.prefix) p.group.setAttribute("visibility", kind === "room" ? "visible" : "hidden");
				const cols = read(f("width"), 1);
				const rows = read(f("depth"), 1);
				const x = read(f("col"), 0) * sq;
				const y = read(f("row"), 0) * sq;
				const w = cols * sq;
				const h = rows * sq;
				set(p.shape, { x, y, width: w, height: h });
				set(p.handle, { x: x + w - 6, y: y + h - 6 });
				set(p.code, { x: x + w / 2, y: y + h / 2 + 5 });
				set(p.size, { x: x + w / 2, y: y - 7 });
				if (p.code && !p.prefix) p.code.textContent = fieldValue(form, "code").toUpperCase() || "?";
				if (p.size)
					p.size.textContent = `${metres.format((cols * squareCm) / 100)} × ${metres.format((rows * squareCm) / 100)} m`;
				if (!p.front) continue;
				const side = fieldValue(form, "front");
				const edge =
					side === "north"
						? [x, y, x + w, y]
						: side === "west"
							? [x, y, x, y + h]
							: side === "east"
								? [x + w, y, x + w, y + h]
								: [x, y + h, x + w, y + h];
				set(p.front, { x1: edge[0], y1: edge[1], x2: edge[2], y2: edge[3] });
				set(p.front, { visibility: kind === "rack" || kind === "cabinet" ? "visible" : "hidden" });
			}
		};
		form.addEventListener("input", draw);
		form.addEventListener("change", draw);
		const squares = (event) => {
			const matrix = svg.getScreenCTM();
			if (!matrix) return null;
			const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
			return { x: p.x / sq, y: p.y / sq };
		};
		let drag = null;
		svg.addEventListener("pointerdown", (event) => {
			if (!(event.target instanceof Element)) return;
			const group = event.target.closest("[data-editing]");
			const part = parts.find((p) => p.group === group);
			const mode = !part
				? null
				: event.target.closest("[data-handle]")
					? "resize"
					: event.target.closest("[data-shape]")
						? "move"
						: null;
			const at = mode ? squares(event) : null;
			if (!part || !mode || !at) return;
			event.preventDefault();
			svg.setPointerCapture(event.pointerId);
			const f = (side) => part.prefix + side;
			drag = {
				f,
				mode,
				at,
				col: read(f("col"), 0),
				row: read(f("row"), 0),
				width: read(f("width"), 1),
				depth: read(f("depth"), 1),
			};
		});
		svg.addEventListener("pointermove", (event) => {
			const at = drag ? squares(event) : null;
			if (!drag || !at) return;
			const dx = Math.round(at.x - drag.at.x);
			const dy = Math.round(at.y - drag.at.y);
			if (drag.mode === "move") {
				write(drag.f("col"), Math.max(0, drag.col + dx));
				write(drag.f("row"), Math.max(0, drag.row + dy));
			} else {
				write(drag.f("width"), Math.max(1, drag.width + dx));
				write(drag.f("depth"), Math.max(1, drag.depth + dy));
			}
			draw();
		});
		const end = () => {
			drag = null;
		};
		svg.addEventListener("pointerup", end);
		svg.addEventListener("pointercancel", end);
		draw();
	}

	// Room shape editor (D212): with JavaScript a room is edited as one outline on the plan editor ([data-outline] on the
	// svg, "x,y x,y …" in squares): presets, walls and corners to drag, a selected wall to cut a step into, undo. Each
	// change writes the outline into the form's hidden `outline` field, which the server splits into the room's
	// rectangle and its areas; until then the place fields (hidden while the editor shows) still hold the room.
	for (const svg of document.querySelectorAll("svg[data-plan-editor]")) {
		const form = document.getElementById(svg.dataset.form ?? "");
		const tools = form?.querySelector("[data-room-tools]");
		const fields = form?.querySelector("[data-room-fields]");
		if (!(form instanceof HTMLFormElement) || !(tools instanceof HTMLElement)) continue;
		const NS = "http://www.w3.org/2000/svg";
		const sq = Number(svg.dataset.square) || 24;
		const squareCm = Number(svg.dataset.squareCm) || 50;
		const limit = { w: Number(svg.dataset.limitWidth) || 200, h: Number(svg.dataset.limitDepth) || 200 };
		const stepDepth = Number(svg.dataset.step) || 2;
		const hint = tools.querySelector("[data-shape-hint]");
		const hidden = form.elements.namedItem("outline");
		const metres = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 2 });
		const fromFields = () => {
			const n = (name, d) => {
				const v = Number.parseInt(fieldValue(form, name), 10);
				return Number.isFinite(v) && v >= 0 ? v : d;
			};
			// A unit turned into a room starts at 6 × 4 m at least: a rack's size is too small to shape.
			const w = Math.max(n("width", 1), Math.round(600 / squareCm));
			const h = Math.max(n("depth", 1), Math.round(400 / squareCm));
			const x = Math.max(0, Math.min(n("col", 0), limit.w - w));
			const y = Math.max(0, Math.min(n("row", 0), limit.h - h));
			return OUTLINE_PRESETS.rect({ x, y, w, h });
		};
		const start = parseOutline(svg.dataset.outline);
		let poly = start ? normOutline(start) : null;
		const history = [];
		let selected = -1;
		let drag = null;
		const say = (key) => {
			if (hint instanceof HTMLElement) hint.textContent = hint.dataset[key] ?? "";
		};
		// The outline is posted only once it was changed: until then the place fields stand.
		const commit = (next, before) => {
			history.push(before);
			poly = next;
			if (hidden instanceof HTMLInputElement) hidden.value = outlineText(poly);
		};
		const layer = document.createElementNS(NS, "g");
		svg.appendChild(layer);
		const add = (tag, attrs, parent = layer) => {
			const el = document.createElementNS(NS, tag);
			for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
			parent.appendChild(el);
			return el;
		};
		const active = () => fieldValue(form, "kind") === "room";
		const draw = () => {
			const on = active();
			tools.hidden = !on;
			if (fields instanceof HTMLElement) fields.hidden = on;
			// The unit and area shapes of the plain editor give way to the outline (areas show only for a room anyway).
			for (const g of svg.querySelectorAll("[data-editing]"))
				if (on) g.setAttribute("visibility", "hidden");
				else if (!g.getAttribute("data-prefix")) g.removeAttribute("visibility");
			if (on && !poly) {
				// Drawn from the fields, and larger than them: post it, so that what is saved is what is shown.
				poly = normOutline(fromFields());
				if (hidden instanceof HTMLInputElement) hidden.value = outlineText(poly);
			}
			layer.replaceChildren();
			if (!on || !poly) return;
			const n = poly.length;
			// Handles keep their size on screen: k is the drawing's units per screen pixel.
			const m = svg.getScreenCTM();
			const k = m && m.a > 0 ? 1 / m.a : 1;
			const coarse = window.matchMedia("(pointer: coarse)").matches;
			const points = poly.map((q) => `${q[0] * sq},${q[1] * sq}`).join(" ");
			add("polygon", { points, class: "pointer-events-none fill-plan-accent/10" });
			add("polygon", {
				points,
				"stroke-width": 2.5,
				"stroke-linejoin": "miter",
				class: "pointer-events-none fill-none stroke-plan-wall",
			});
			const moving = (i) =>
				drag?.moved &&
				(drag.wall === i || (drag.corner !== undefined && (drag.corner === i || (drag.corner + n - 1) % n === i)));
			wallHandles(add, poly, sq, k, coarse, layer, selected, moving, metres, squareCm);
		};
		const squares = (event) => {
			const m = svg.getScreenCTM();
			if (!m) return null;
			const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m.inverse());
			return [p.x / sq, p.y / sq];
		};
		svg.addEventListener("pointerdown", (event) => {
			if (!active() || !poly || !(event.target instanceof Element)) return;
			const wall = event.target.closest("[data-wall]");
			const corner = event.target.closest("[data-corner]");
			const at = squares(event);
			if ((!wall && !corner) || !at) {
				if (selected >= 0) {
					selected = -1;
					say("hint");
					draw();
				}
				return;
			}
			event.preventDefault();
			svg.setPointerCapture(event.pointerId);
			drag = {
				at,
				from: poly.map((q) => q.slice()),
				moved: false,
				wall: wall ? Number(wall.getAttribute("data-wall")) : undefined,
				corner: corner ? Number(corner.getAttribute("data-corner")) : undefined,
			};
		});
		svg.addEventListener("pointermove", (event) => {
			const at = drag ? squares(event) : null;
			if (!drag || !at) return;
			const dx = Math.round(at[0] - drag.at[0]);
			const dy = Math.round(at[1] - drag.at[1]);
			if (!dx && !dy && !drag.moved) return;
			drag.moved = true;
			selected = -1;
			const r = dragOutline(drag.from, drag, dx, dy);
			if (validOutline(r, limit)) poly = r;
			draw();
		});
		const end = () => {
			if (!drag) return;
			if (!drag.moved && drag.wall !== undefined) {
				selected = drag.wall;
				say("selected");
			} else if (drag.moved && JSON.stringify(poly) !== JSON.stringify(drag.from)) {
				const next = poly;
				poly = drag.from;
				commit(next, drag.from);
				say("hint");
			}
			drag = null;
			draw();
		};
		svg.addEventListener("pointerup", end);
		svg.addEventListener("pointercancel", end);
		for (const button of tools.querySelectorAll("[data-shape-preset]"))
			button.addEventListener("click", () => {
				if (!poly) return;
				const b = outlineBox(poly);
				const r = normOutline(
					OUTLINE_PRESETS[button.getAttribute("data-shape-preset")]({ ...b, w: Math.max(3, b.w), h: Math.max(3, b.h) }),
				);
				if (!validOutline(r, limit)) return;
				commit(r, poly);
				selected = -1;
				say("hint");
				draw();
			});
		tools.querySelector("[data-cut-step]")?.addEventListener("click", () => {
			if (selected < 0 || !poly) return say("pick");
			const r = cutOutline(poly, selected, stepDepth, limit);
			if (!r) return say("short");
			commit(r, poly);
			selected = -1;
			say("cut");
			draw();
		});
		tools.querySelector("[data-shape-undo]")?.addEventListener("click", () => {
			const before = history.pop();
			if (!before) return;
			poly = before;
			// Back to the saved outline: nothing to post, the place fields hold it.
			const text = outlineText(poly);
			const saved = start ? outlineText(normOutline(start)) : null;
			if (hidden instanceof HTMLInputElement) hidden.value = text === saved ? "" : text;
			selected = -1;
			say("hint");
			draw();
		});
		form.addEventListener("change", (event) => {
			// Until the outline is changed, switching to a room starts from the saved outline or the place fields.
			if (event.target instanceof HTMLInputElement && event.target.name === "kind" && !history.length)
				poly = start ? normOutline(start) : null;
			draw();
		});
		// The plain editor redraws its shapes as fields change: keep them hidden behind the outline.
		form.addEventListener("input", draw);
		// Handles are sized in screen pixels: a resized window changes the drawing's scale.
		window.addEventListener("resize", draw);
		draw();
	}

	// Plan editor board (D214): [data-plan-board] holds a drawing of the plan; with JavaScript it becomes the editor of the
	// whole plan. Each unit is a section of the form ([data-plan-item="u12_"], its fields named u12_col…): the board is
	// drawn from those fields, and dragging, resizing, rotating or reshaping a unit writes them. A unit added from the
	// tools is a section cloned from <template data-plan-template="rack"> and renamed n1_, n2_… Nothing is saved before
	// the form is posted; leaving with changes asks first.
	for (const board of document.querySelectorAll("[data-plan-board]")) {
		const form = document.getElementById(board.dataset.form ?? "");
		const list = form?.querySelector("[data-plan-items]");
		if (!(form instanceof HTMLFormElement) || !(list instanceof HTMLElement)) continue;
		const NS = "http://www.w3.org/2000/svg";
		// data-square: drawing units of one square (48 per metre); data-square-cm: its real size.
		const sq = Number(board.dataset.square) || 24;
		const squareCm = Number(board.dataset.squareCm) || 50;
		const limit = { w: Number(board.dataset.limitWidth) || 200, h: Number(board.dataset.limitDepth) || 200 };
		const fixed = board.dataset.fixed === "1";
		const base = { w: Number(board.dataset.width) || 24, h: Number(board.dataset.depth) || 14 };
		const step = Number(board.dataset.step) || 2;
		const taken = new Set((board.dataset.codes ?? "").split(",").filter(Boolean));
		const squares = (cm) => Math.max(1, Math.round(cm / squareCm));
		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
		const metres = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 2 });
		const length = (n) => metres.format((n * squareCm) / 100);
		const coarse = window.matchMedia("(pointer: coarse)").matches;
		for (const el of form.querySelectorAll("[data-plan-tools], [data-plan-hint]"))
			if (el instanceof HTMLElement) el.hidden = false;
		for (const el of form.querySelectorAll("[data-plan-nojs]")) if (el instanceof HTMLElement) el.hidden = true;
		const hint = form.querySelector("[data-plan-hint]");
		const hintText = hint?.textContent ?? "";
		const emptyHint = form.querySelector("[data-plan-empty]");
		const dirtyBadge = form.querySelector("[data-plan-dirty]");
		const undoButton = form.querySelector("[data-plan-undo]");
		const holds = (kind) => kind === "rack" || kind === "cabinet" || kind === "floor";
		const binned = (kind) => kind === "rack" || kind === "cabinet";
		const faced = (kind) => binned(kind) || kind === "door";

		// Units, one per section, with their fields.
		const items = [];
		const input = (it, f) => form.elements.namedItem(it.prefix + f);
		const get = (it, f) => {
			const el = input(it, f);
			return el && "value" in el ? String(el.value) : "";
		};
		const int = (it, f, d) => {
			const n = Number.parseInt(get(it, f), 10);
			return Number.isFinite(n) ? n : d;
		};
		const put = (it, f, v) => {
			const el = input(it, f);
			if (el && "value" in el) el.value = String(v);
		};
		const rectOf = (it) => ({
			col: Math.max(0, int(it, "col", 0)),
			row: Math.max(0, int(it, "row", 0)),
			width: Math.max(1, int(it, "width", 1)),
			depth: Math.max(1, int(it, "depth", 1)),
		});
		const setRect = (it, r) => {
			for (const f of ["col", "row", "width", "depth"]) put(it, f, r[f]);
		};
		// A room's box: its outline's when it has one, else its own rectangle.
		const boxOf = (it) => {
			if (it.poly) {
				const b = outlineBox(it.poly);
				return { col: b.x, row: b.y, width: b.w, depth: b.h };
			}
			return rectOf(it);
		};
		// A room's outline is posted only once it differs from the saved one (a new room always posts it).
		const writeOutline = (it) => {
			if (!it.poly) return;
			const text = outlineText(it.poly);
			put(it, "outline", !it.isNew && it.saved && text === outlineText(it.saved) ? "" : text);
		};
		const adopt = (section) => {
			const it = {
				prefix: section.dataset.planItem ?? "",
				section,
				kind: section.dataset.kind ?? "rack",
				label: section.dataset.kindLabel ?? "",
				isNew: !section.dataset.unitId,
				poly: null,
				saved: null,
				rects: null,
			};
			if (it.kind === "room") {
				const saved = parseOutline(section.dataset.outline);
				const posted = parseOutline(get(it, "outline"));
				it.saved = saved ? normOutline(saved) : null;
				if (posted) it.poly = normOutline(posted);
				else if (it.saved) it.poly = it.saved;
				else if (section.dataset.rects)
					// A room around a hole: drawn by its rectangles, reshaped on its own form only.
					it.rects = section.dataset.rects.split(";").map((g) => g.split(",").map(Number));
				else {
					const r = rectOf(it);
					it.poly = normOutline(OUTLINE_PRESETS.rect({ x: r.col, y: r.row, w: r.width, h: r.depth }));
				}
			}
			for (const el of section.querySelectorAll("[data-plan-numbers]")) if (el instanceof HTMLElement) el.hidden = true;
			for (const el of section.querySelectorAll("[data-plan-rotate], [data-plan-remove]"))
				if (el instanceof HTMLElement) el.hidden = false;
			for (const el of section.querySelectorAll("[data-plan-room-tools]"))
				if (el instanceof HTMLElement) el.hidden = !it.poly;
			items.push(it);
			return it;
		};
		for (const section of list.querySelectorAll("[data-plan-item]")) adopt(section);

		// Changes: undo steps back through snapshots of every unit's place; leaving with changes asks first.
		let dirty = false;
		const setDirty = () => {
			dirty = true;
			if (dirtyBadge instanceof HTMLElement) dirtyBadge.hidden = false;
		};
		// A unit the server refused is shown in red with the reason until it is changed.
		const touched = (it) => {
			if (it?.section.dataset.invalid !== "true") return;
			delete it.section.dataset.invalid;
			for (const e of it.section.querySelectorAll("[data-plan-error]")) if (e instanceof HTMLElement) e.hidden = true;
		};
		const history = [];
		const remember = () => {
			history.push({
				present: items.slice(),
				state: items.map((it) => ({
					it,
					rect: rectOf(it),
					front: get(it, "front"),
					poly: it.poly ? it.poly.map((q) => q.slice()) : null,
					outline: get(it, "outline"),
				})),
			});
			if (history.length > 200) history.shift();
			if (undoButton instanceof HTMLButtonElement) undoButton.disabled = false;
			setDirty();
		};
		const detach = (it) => {
			it.section.remove();
			items.splice(items.indexOf(it), 1);
		};
		const undo = () => {
			const s = history.pop();
			if (!s) return;
			// Units added since are taken out again, units removed since are put back.
			for (const it of items.slice()) if (!s.present.includes(it)) detach(it);
			for (const it of s.present)
				if (!items.includes(it)) {
					list.appendChild(it.section);
					items.push(it);
				}
			for (const x of s.state) {
				setRect(x.it, x.rect);
				put(x.it, "front", x.front);
				x.it.poly = x.poly;
				put(x.it, "outline", x.outline);
			}
			if (undoButton instanceof HTMLButtonElement) undoButton.disabled = history.length === 0;
			select(selected && items.includes(selected) ? selected : null);
		};
		form.addEventListener("submit", () => {
			dirty = false;
		});
		window.addEventListener("beforeunload", (event) => {
			if (!dirty) return;
			event.preventDefault();
			event.returnValue = "";
		});

		// The drawing.
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("class", "block font-sans select-none [&_*]:[vector-effect:non-scaling-stroke]");
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", board.querySelector("svg")?.getAttribute("aria-label") ?? "");
		board.replaceChildren(svg);
		const pad = 16;
		let zoom = 0;
		let extent = { ...base };
		const el = (tag, attrs, parent) => {
			const e = document.createElementNS(NS, tag);
			for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
			parent.appendChild(e);
			return e;
		};
		const text = (parent, attrs, content) => {
			el("text", attrs, parent).textContent = content;
		};
		const viewSize = () => ({ w: extent.w * sq + 2 * pad, h: extent.h * sq + 2 * pad });
		const fitZoom = () => {
			const v = viewSize();
			return clamp(Math.min((board.clientWidth - 2) / v.w, (window.innerHeight * 0.72) / v.h), 0.2, 1.6);
		};
		const resize = () => {
			const v = viewSize();
			if (!zoom) zoom = fitZoom();
			svg.setAttribute("viewBox", `${-pad} ${-pad} ${v.w} ${v.h}`);
			svg.setAttribute("width", String(Math.round(v.w * zoom)));
			svg.setAttribute("height", String(Math.round(v.h * zoom)));
		};
		const setZoom = (next, ax, ay) => {
			const x = ax ?? board.clientWidth / 2;
			const y = ay ?? board.clientHeight / 2;
			const ux = (board.scrollLeft + x) / zoom;
			const uy = (board.scrollTop + y) / zoom;
			zoom = clamp(next, 0.15, 4);
			resize();
			board.scrollLeft = ux * zoom - x;
			board.scrollTop = uy * zoom - y;
			draw();
		};
		const gridStep = (() => {
			const round = [10, 20, 25, 50, 100, 200, 500, 1000];
			const min = Math.ceil(1200 / (48 * squareCm));
			for (let s = min; s * squareCm <= 1000; s++) if (round.includes(s * squareCm)) return s;
			return min;
		})();
		const isMetre = (i) => (100 % squareCm === 0 ? (i * squareCm) % 100 === 0 : (i / gridStep) % 2 === 0);
		const edgeOf = (x, y, w, h, front) =>
			front === "north"
				? [x, y, x + w, y]
				: front === "west"
					? [x, y, x, y + h]
					: front === "east"
						? [x + w, y, x + w, y + h]
						: [x, y + h, x + w, y + h];
		const overlaps = (a, b) =>
			a.col < b.col + b.width && b.col < a.col + a.width && a.row < b.row + b.depth && b.row < a.row + a.depth;
		// Storage units standing on the same squares: drawn in red until moved apart (the server refuses them anyway).
		const clashes = () => {
			const storing = items.filter((it) => holds(it.kind));
			const out = new Set();
			for (let i = 0; i < storing.length; i++)
				for (let j = i + 1; j < storing.length; j++)
					if (overlaps(rectOf(storing[i]), rectOf(storing[j]))) {
						out.add(storing[i]);
						out.add(storing[j]);
					}
			return out;
		};
		const polygons = (it) =>
			it.poly
				? [it.poly]
				: (it.rects ?? []).map(([c, r, w, d]) => [
						[c, r],
						[c + w, r],
						[c + w, r + d],
						[c, r + d],
					]);
		const pathOf = (polys) => polys.map((p) => `M${p.map((q) => `${q[0] * sq} ${q[1] * sq}`).join(" L")} Z`).join(" ");

		let selected = null;
		let wall = -1;
		let drag = null;

		const drawRoomWalls = (it, layer, invalid) => {
			const sel = it === selected;
			el(
				"path",
				{
					d: pathOf(polygons(it)),
					"stroke-width": 2.5,
					"stroke-linejoin": "miter",
					class: invalid
						? "pointer-events-none fill-none stroke-destructive"
						: sel
							? "pointer-events-none fill-plan-accent/10 stroke-plan-accent"
							: "pointer-events-none fill-none stroke-plan-wall",
				},
				layer,
			);
			const corners = polygons(it).flat();
			if (!corners.length) return;
			const tl = corners.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a));
			text(
				layer,
				{
					x: tl[0] * sq + 9,
					y: tl[1] * sq + 17,
					class: sel
						? "pointer-events-none fill-plan-accent text-[9.5px] font-semibold tracking-wider uppercase"
						: "pointer-events-none fill-muted-foreground text-[9.5px] font-semibold tracking-wider uppercase",
				},
				get(it, "name") || get(it, "code").toUpperCase() || it.label,
			);
		};
		const drawDoor = (it, layer) => {
			const r = rectOf(it);
			const sel = it === selected;
			const x = r.col * sq;
			const y = r.row * sq;
			const w = r.width * sq;
			const h = r.depth * sq;
			const front = get(it, "front");
			let cut;
			let leaf;
			let arc;
			if (r.width > r.depth || (r.width === r.depth && front !== "east" && front !== "west")) {
				const wy = y + h / 2;
				const down = front !== "north";
				cut = [x, wy, x + w, wy];
				leaf = `M${x} ${wy} V${down ? wy + w : wy - w}`;
				arc = `M${x + w} ${wy} A${w} ${w} 0 0 ${down ? 1 : 0} ${x} ${down ? wy + w : wy - w}`;
			} else {
				const wx = x + w / 2;
				const right = front !== "west";
				cut = [wx, y, wx, y + h];
				leaf = `M${wx} ${y} H${right ? wx + h : wx - h}`;
				arc = `M${wx} ${y + h} A${h} ${h} 0 0 ${right ? 0 : 1} ${right ? wx + h : wx - h} ${y}`;
			}
			const g = el("g", { "data-item": it.prefix, class: "cursor-pointer" }, layer);
			el("rect", { x, y, width: w, height: h, class: sel ? "fill-plan-accent/15" : "fill-transparent" }, g);
			el("line", { x1: cut[0], y1: cut[1], x2: cut[2], y2: cut[3], "stroke-width": 6, class: "stroke-plan-floor" }, g);
			el(
				"path",
				{ d: arc, "stroke-width": 1, "stroke-dasharray": "2 3", class: "fill-none stroke-muted-foreground/70" },
				g,
			);
			el(
				"path",
				{ d: leaf, "stroke-width": 1.5, class: sel ? "fill-none stroke-plan-accent" : "fill-none stroke-plan-wall" },
				g,
			);
		};
		const drawLandmark = (it, layer) => {
			const r = rectOf(it);
			const sel = it === selected;
			const g = el("g", { "data-item": it.prefix, class: "cursor-pointer" }, layer);
			el(
				"rect",
				{
					x: r.col * sq,
					y: r.row * sq,
					width: r.width * sq,
					height: r.depth * sq,
					rx: 3,
					"stroke-width": 1,
					"stroke-dasharray": "3 3",
					class: sel ? "fill-plan-accent/15 stroke-plan-accent" : "fill-muted/60 stroke-muted-foreground/60",
				},
				g,
			);
			text(
				g,
				{
					x: (r.col + r.width / 2) * sq,
					y: (r.row + r.depth / 2) * sq + 4,
					"text-anchor": "middle",
					class: "pointer-events-none fill-muted-foreground text-[10.5px] italic",
				},
				get(it, "name") || get(it, "code").toUpperCase() || it.label,
			);
		};
		const drawUnit = (it, layer, bad) => {
			const r = rectOf(it);
			const sel = it === selected;
			const invalid = bad.has(it) || it.section.dataset.invalid === "true";
			const x = r.col * sq;
			const y = r.row * sq;
			const w = r.width * sq;
			const h = r.depth * sq;
			const front = get(it, "front") || "south";
			const g = el("g", { "data-item": it.prefix, class: sel ? "cursor-move" : "cursor-pointer" }, layer);
			el(
				"rect",
				{
					x,
					y,
					width: w,
					height: h,
					rx: 1.5,
					"stroke-width": sel || invalid ? 1.75 : 1,
					"stroke-dasharray": it.kind === "floor" ? "4 3" : undefined,
					class: invalid
						? "fill-destructive/15 stroke-destructive"
						: sel
							? "fill-plan-accent/15 stroke-plan-accent"
							: it.kind === "floor"
								? "fill-plan-unit/50 stroke-foreground/40"
								: "fill-plan-unit stroke-foreground/40",
				},
				g,
			);
			if (binned(it.kind)) {
				const n = clamp(int(it, "positions", 1), 1, 30);
				const along = front === "south" || front === "north";
				const dividers = el("g", { class: "pointer-events-none stroke-foreground/15", "stroke-width": 1 }, g);
				for (let i = 1; i < n; i++) {
					const d = along ? x + (i * w) / n : y + (i * h) / n;
					el("line", along ? { x1: d, y1: y, x2: d, y2: y + h } : { x1: x, y1: d, x2: x + w, y2: d }, dividers);
				}
			}
			if (it.kind !== "floor") {
				const [x1, y1, x2, y2] = edgeOf(x, y, w, h, front);
				el(
					"line",
					{
						x1,
						y1,
						x2,
						y2,
						"stroke-width": 3,
						class: invalid
							? "pointer-events-none stroke-destructive"
							: sel
								? "pointer-events-none stroke-plan-accent"
								: "pointer-events-none stroke-foreground/70",
					},
					g,
				);
			}
			const name = get(it, "name");
			const named = name !== "" && w >= 120 && h >= 48;
			text(
				g,
				{
					x: x + w / 2,
					y: y + h / 2 + (named ? 0 : 4.5),
					"text-anchor": "middle",
					class: sel
						? "pointer-events-none fill-plan-accent text-[13px] font-semibold"
						: "pointer-events-none fill-foreground/85 text-[13px] font-semibold",
				},
				get(it, "code").toUpperCase() || "?",
			);
			if (named)
				text(
					g,
					{
						x: x + w / 2,
						y: y + h / 2 + 13,
						"text-anchor": "middle",
						class: "pointer-events-none fill-muted-foreground text-[9.5px]",
					},
					name.length > w / 5.5 ? `${name.slice(0, Math.max(1, Math.floor(w / 5.5) - 1))}…` : name,
				);
		};
		// The selected unit's handles: a corner to resize it and its size, or a room's walls and corners.
		const drawHandles = (layer) => {
			const it = selected;
			if (!it) return;
			const k = 1 / zoom;
			if (it.poly) {
				const n = it.poly.length;
				const moving = (i) =>
					drag?.moved &&
					(drag.wall === i || (drag.corner !== undefined && (drag.corner === i || (drag.corner + n - 1) % n === i)));
				wallHandles(
					(tag, attrs, parent) => el(tag, attrs, parent),
					it.poly,
					sq,
					k,
					coarse,
					layer,
					wall,
					moving,
					metres,
					squareCm,
				);
				return;
			}
			if (it.kind === "room") return;
			const r = rectOf(it);
			const x = (r.col + r.width) * sq;
			const y = (r.row + r.depth) * sq;
			const s = (coarse ? 20 : 12) * k;
			text(
				layer,
				{
					x: (r.col + r.width / 2) * sq,
					y: r.row * sq - 7 * k,
					"text-anchor": "middle",
					class: "pointer-events-none fill-plan-accent text-[10px] font-medium tabular-nums",
				},
				`${length(r.width)} × ${length(r.depth)} m`,
			);
			el(
				"rect",
				{
					"data-handle": "resize",
					x: x - s / 2,
					y: y - s / 2,
					width: s,
					height: s,
					rx: s / 5,
					"stroke-width": 1.5,
					class: "cursor-nwse-resize fill-background stroke-plan-accent",
				},
				layer,
			);
		};
		const draw = () => {
			// The board reaches 2 m past the furthest unit, within the plan's limit (exactly the main area when fixed).
			if (fixed) extent = { ...limit };
			else {
				let w = base.w;
				let h = base.h;
				for (const it of items) {
					const b = boxOf(it);
					w = Math.max(w, b.col + b.width + squares(200));
					h = Math.max(h, b.row + b.depth + squares(200));
				}
				extent = { w: Math.min(w, limit.w), h: Math.min(h, limit.h) };
			}
			resize();
			svg.replaceChildren();
			const W = extent.w * sq;
			const H = extent.h * sq;
			const rooms = items.filter((it) => it.kind === "room");
			el(
				"rect",
				{
					x: 0,
					y: 0,
					width: W,
					height: H,
					rx: 3,
					"stroke-width": rooms.length ? undefined : 2,
					class: rooms.length ? "fill-plan-ground" : "fill-plan-floor stroke-plan-wall",
				},
				svg,
			);
			const floors = el("g", {}, svg);
			for (const it of rooms)
				for (const p of polygons(it))
					el(
						"polygon",
						{
							"data-item": it.prefix,
							points: p.map((q) => `${q[0] * sq},${q[1] * sq}`).join(" "),
							class: it === selected ? "cursor-move fill-plan-floor" : "cursor-pointer fill-plan-floor",
						},
						floors,
					);
			const grid = el("g", { class: "pointer-events-none", "stroke-width": 1 }, svg);
			const minor = el("g", { class: "stroke-foreground/5" }, grid);
			const major = el("g", { class: "stroke-foreground/12" }, grid);
			// Thin lines closer than 6 px on screen only blur the drawing: keep the metres then.
			const dense = gridStep * sq * zoom < 6;
			for (let i = gridStep; i < extent.w; i += gridStep)
				if (isMetre(i) || !dense) el("line", { x1: i * sq, y1: 0, x2: i * sq, y2: H }, isMetre(i) ? major : minor);
			for (let j = gridStep; j < extent.h; j += gridStep)
				if (isMetre(j) || !dense) el("line", { x1: 0, y1: j * sq, x2: W, y2: j * sq }, isMetre(j) ? major : minor);
			const walls = el("g", {}, svg);
			for (const it of rooms) drawRoomWalls(it, walls, it.section.dataset.invalid === "true");
			const above = el("g", {}, svg);
			for (const it of items) if (it.kind === "door") drawDoor(it, above);
			for (const it of items) if (it.kind === "landmark") drawLandmark(it, above);
			const bad = clashes();
			for (const it of items) if (holds(it.kind)) drawUnit(it, above, bad);
			drawHandles(el("g", {}, svg));
			// The scale bar.
			const bar = el("g", { class: "pointer-events-none fill-muted-foreground text-[10.5px]" }, svg);
			el(
				"path",
				{ d: `M0 ${H + 6} V${H + 10} H48 V${H + 6}`, "stroke-width": 1, class: "fill-none stroke-muted-foreground" },
				bar,
			);
			text(bar, { x: 54, y: H + 13 }, "1 m");
			// What the hint says: a clash of the selected unit, else how to use the board.
			if (hint instanceof HTMLElement) {
				const clash = selected !== null && bad.has(selected);
				hint.textContent = clash ? (board.dataset.overlap ?? "") : hintText;
				hint.classList.toggle("text-destructive", clash);
				hint.classList.toggle("text-muted-foreground", !clash);
			}
			for (const it of items) refreshSection(it);
		};
		// A section's header and bins line follow its fields.
		const refreshSection = (it) => {
			const s = it.section;
			const b = boxOf(it);
			const code = get(it, "code").toUpperCase();
			const title = s.querySelector("[data-plan-title]");
			if (title) title.textContent = get(it, "name") || it.label;
			const size = s.querySelector("[data-plan-size]");
			if (size) size.textContent = `${it.label} · ${length(b.width)} × ${length(b.depth)} m`;
			const badge = s.querySelector("[data-plan-badge] > span");
			if (badge && holds(it.kind)) badge.textContent = code || "?";
			const bins = s.querySelector("[data-plan-bins]");
			if (bins instanceof HTMLElement) {
				const c = code || "?";
				const range = bins.dataset.range ?? "";
				bins.textContent = range
					.replace("{from}", `${c}-1-1`)
					.replace("{to}", `${c}-${Math.max(1, int(it, "levels", 1))}-${Math.max(1, int(it, "positions", 1))}`);
			}
		};
		const sayRoom = (it, key) => {
			const h = it.section.querySelector("[data-shape-hint]");
			if (h instanceof HTMLElement) h.textContent = h.dataset[key] ?? "";
		};
		// Selecting a unit shows its section alone, open; no selection shows the list of units, closed.
		const select = (it) => {
			if (selected && selected !== it) sayRoom(selected, "hint");
			selected = it;
			wall = -1;
			for (const x of items) {
				if (x === it) x.section.dataset.selected = "true";
				else delete x.section.dataset.selected;
				x.section.hidden = it !== null && x !== it;
				const body = x.section.querySelector("[data-plan-body]");
				if (body instanceof HTMLElement) body.hidden = x !== it;
			}
			if (emptyHint instanceof HTMLElement) emptyHint.hidden = it !== null;
			list.scrollTop = 0;
			draw();
		};
		const reveal = (it) => {
			const b = boxOf(it);
			const cx = ((b.col + b.width / 2) * sq + pad) * zoom;
			const cy = ((b.row + b.depth / 2) * sq + pad) * zoom;
			const inside =
				cx > board.scrollLeft &&
				cx < board.scrollLeft + board.clientWidth &&
				cy > board.scrollTop &&
				cy < board.scrollTop + board.clientHeight;
			if (!inside) {
				board.scrollLeft = cx - board.clientWidth / 2;
				board.scrollTop = cy - board.clientHeight / 2;
			}
		};

		// Moving things: by dragging, by the arrow keys, by turning them a quarter.
		const moveBy = (it, from, dx, dy) => {
			if (it.poly) {
				const b = outlineBox(from.poly);
				const x = clamp(dx, -b.x, limit.w - b.x - b.w);
				const y = clamp(dy, -b.y, limit.h - b.y - b.h);
				it.poly = from.poly.map((q) => [q[0] + x, q[1] + y]);
				writeOutline(it);
				return;
			}
			const r = from.rect;
			setRect(it, {
				...r,
				col: clamp(r.col + dx, 0, limit.w - r.width),
				row: clamp(r.row + dy, 0, limit.h - r.depth),
			});
		};
		const nudge = (dx, dy) => {
			const it = selected;
			if (!it || (it.kind === "room" && !it.poly)) return;
			remember();
			touched(it);
			moveBy(it, { rect: rectOf(it), poly: it.poly }, dx, dy);
			draw();
		};
		const TURN = { south: "east", east: "north", north: "west", west: "south" };
		const rotate = (it) => {
			if (it.kind === "room") return;
			remember();
			touched(it);
			const r = rectOf(it);
			const w = r.depth;
			const h = r.width;
			const col = clamp(Math.round((2 * r.col + r.width - w) / 2), 0, limit.w - w);
			const row = clamp(Math.round((2 * r.row + r.depth - h) / 2), 0, limit.h - h);
			setRect(it, { col, row, width: w, depth: h });
			if (faced(it.kind)) put(it, "front", TURN[get(it, "front")] ?? "south");
			draw();
		};

		// Adding a unit: a section from its kind's template, at a free spot in view, with the next free code.
		const SIZES = {
			rack: [200, 50],
			cabinet: [100, 50],
			floor: [150, 150],
			room: [600, 400],
			door: [100, 100],
			landmark: [200, 100],
		};
		const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const nextCode = () => {
			const used = new Set([...taken, ...items.map((it) => get(it, "code").toUpperCase())]);
			for (let n = 0; n < 100; n++)
				for (const c of LETTERS) {
					const code = n ? `${c}${n}` : c;
					if (!used.has(code)) return code;
				}
			return "";
		};
		const nextPrefix = () => {
			let k = 1;
			while (
				form.elements.namedItem(`n${k}_kind`) ||
				items.some((it) => it.prefix === `n${k}_`) ||
				removed.has(`n${k}_`)
			)
				k++;
			return `n${k}_`;
		};
		const removed = new Set();
		// The walls of every room, as segments [x1, y1, x2, y2] with x1 <= x2 and y1 <= y2.
		const wallSegments = () =>
			items
				.filter((it) => it.kind === "room")
				.flatMap(polygons)
				.flatMap((p) =>
					p.map((a, i) => {
						const b = p[(i + 1) % p.length];
						return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
					}),
				);
		// Whether a wall runs through the inside of a rectangle (a unit placed across it would stand in two rooms).
		const crossesWall = (r, walls) =>
			walls.some(([x1, y1, x2, y2]) =>
				x1 === x2
					? r.col < x1 && x1 < r.col + r.width && Math.min(y2, r.row + r.depth) > Math.max(y1, r.row)
					: r.row < y1 && y1 < r.row + r.depth && Math.min(x2, r.col + r.width) > Math.max(x1, r.col),
			);
		// The part of the plan in view, in squares.
		const inView = () => ({
			x: (board.scrollLeft / zoom - pad) / sq,
			y: (board.scrollTop / zoom - pad) / sq,
			w: board.clientWidth / zoom / sq,
			h: board.clientHeight / zoom / sq,
		});
		// A free place for a new unit near the middle of the view: clear of the units of its sort (rooms of rooms), and
		// for what stands in a room, not across a wall.
		const freeSpot = (kind, w, h) => {
			const others = items
				.filter((it) => (kind === "room" ? it.kind === "room" : holds(kind) ? holds(it.kind) : it.kind === kind))
				.map(boxOf);
			const walls = kind === "room" ? [] : wallSegments();
			const view = inView();
			const cx = clamp(Math.round(view.x + view.w / 2 - w / 2), 0, Math.max(0, limit.w - w));
			const cy = clamp(Math.round(view.y + view.h / 3 - h / 2), 0, Math.max(0, limit.h - h));
			const stride = Math.max(1, Math.round(step / 2));
			for (let ring = 0; ring < 60; ring++)
				for (let dy = -ring; dy <= ring; dy++)
					for (let dx = -ring; dx <= ring; dx++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
						const r = { col: cx + dx * stride, row: cy + dy * stride, width: w, depth: h };
						if (r.col < 0 || r.row < 0 || r.col + w > limit.w || r.row + h > limit.h) continue;
						if (!others.some((o) => overlaps(o, r)) && !crossesWall(r, walls)) return r;
					}
			return { col: cx, row: cy, width: w, depth: h };
		};
		// A new door goes across the wall nearest to the middle of the view, wherever it is free of other doors: along
		// the wall `w` squares, `d` across it (an even number, so that the wall runs through its middle).
		const doorSpot = (w, d) => {
			const view = inView();
			const c = [view.x + view.w / 2, view.y + view.h / 2];
			const doors = items.filter((it) => it.kind === "door").map(rectOf);
			let best = null;
			for (const [x1, y1, x2, y2] of wallSegments()) {
				const flat = y1 === y2;
				const len = flat ? x2 - x1 : y2 - y1;
				if (len < w) continue;
				const along = flat ? clamp(Math.round(c[0] - w / 2), x1, x2 - w) : clamp(Math.round(c[1] - w / 2), y1, y2 - w);
				const r = flat
					? { col: along, row: y1 - d / 2, width: w, depth: d }
					: { col: x1 - d / 2, row: along, width: d, depth: w };
				if (r.col < 0 || r.row < 0 || doors.some((o) => overlaps(o, r))) continue;
				const mid = [r.col + r.width / 2, r.row + r.depth / 2];
				const dist = Math.hypot(mid[0] - c[0], mid[1] - c[1]);
				if (!best || dist < best.dist) best = { dist, r, front: flat ? "south" : "east" };
			}
			return best;
		};
		const add = (kind) => {
			const template = form.querySelector(`template[data-plan-template="${kind}"]`);
			if (!(template instanceof HTMLTemplateElement)) return;
			const prefix = nextPrefix();
			// The server reads n1_ to n<data-max-new>_: save before adding more.
			if (Number(prefix.slice(1, -1)) > (Number(board.dataset.maxNew) || 40)) return;
			const fragment = template.content.cloneNode(true);
			if (!(fragment instanceof DocumentFragment)) return;
			for (const node of fragment.querySelectorAll("*"))
				for (const a of [...node.attributes])
					if (a.value.includes("nX_")) node.setAttribute(a.name, a.value.replaceAll("nX_", prefix));
			const section = fragment.querySelector("[data-plan-item]");
			if (!(section instanceof HTMLElement)) return;
			remember();
			list.appendChild(fragment);
			const it = adopt(section);
			const [wcm, dcm] = SIZES[kind] ?? [100, 100];
			const door = kind === "door" ? doorSpot(squares(wcm), 2 * squares(dcm / 2)) : null;
			const spot = door?.r ?? freeSpot(kind, squares(wcm), squares(dcm));
			setRect(it, spot);
			if (door) put(it, "front", door.front);
			if (kind === "room") {
				it.poly = normOutline(OUTLINE_PRESETS.rect({ x: spot.col, y: spot.row, w: spot.width, h: spot.depth }));
				writeOutline(it);
				for (const t of section.querySelectorAll("[data-plan-room-tools]"))
					if (t instanceof HTMLElement) t.hidden = false;
			}
			if (holds(kind)) put(it, "code", nextCode());
			select(it);
			reveal(it);
			const first = section.querySelector('input[name$="name"]');
			if (first instanceof HTMLInputElement && !coarse) first.focus({ preventScroll: true });
		};
		const remove = (it) => {
			if (!it.isNew) return;
			remember();
			removed.add(it.prefix);
			detach(it);
			select(null);
		};

		// The pointer: a unit is selected and dragged at once (a room once selected); its corner resizes it; a room's
		// walls and corners reshape it; empty ground scrolls the board, and a tap there clears the selection.
		const toSquares = (event) => {
			const m = svg.getScreenCTM();
			if (!m) return null;
			const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m.inverse());
			return { x: p.x / sq, y: p.y / sq };
		};
		svg.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			const target = event.target instanceof Element ? event.target : null;
			const at = toSquares(event);
			if (!at) return;
			const itemEl = target?.closest("[data-item]");
			const it = itemEl ? (items.find((x) => x.prefix === itemEl.getAttribute("data-item")) ?? null) : null;
			const wallEl = target?.closest("[data-wall]");
			const cornerEl = target?.closest("[data-corner]");
			let mode = "pan";
			if (selected && target?.closest("[data-handle]")) mode = "resize";
			else if (selected?.poly && (wallEl || cornerEl)) mode = wallEl ? "wall" : "corner";
			else if (it && it.kind === "room" && (it !== selected || !it.poly)) mode = "pick";
			else if (it) mode = "move";
			const subject = mode === "resize" || mode === "wall" || mode === "corner" ? selected : it;
			event.preventDefault();
			svg.setPointerCapture(event.pointerId);
			drag = {
				mode,
				it: subject,
				at,
				x: event.clientX,
				y: event.clientY,
				left: board.scrollLeft,
				top: board.scrollTop,
				moved: false,
				changed: false,
				rect: subject ? rectOf(subject) : null,
				poly: subject?.poly ? subject.poly.map((q) => q.slice()) : null,
				wall: wallEl ? Number(wallEl.getAttribute("data-wall")) : undefined,
				corner: cornerEl ? Number(cornerEl.getAttribute("data-corner")) : undefined,
			};
			if (mode === "move" && it !== selected) select(it);
		});
		svg.addEventListener("pointermove", (event) => {
			if (!drag) return;
			if (!drag.moved && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 4) return;
			drag.moved = true;
			if (drag.mode === "pan" || drag.mode === "pick") {
				drag.mode = "pan";
				board.scrollLeft = drag.left - (event.clientX - drag.x);
				board.scrollTop = drag.top - (event.clientY - drag.y);
				return;
			}
			const at = toSquares(event);
			const it = drag.it;
			if (!at || !it) return;
			const dx = Math.round(at.x - drag.at.x);
			const dy = Math.round(at.y - drag.at.y);
			if (!drag.changed && !dx && !dy) return;
			if (!drag.changed) {
				// The state before the drag, for undo.
				remember();
				touched(it);
				drag.changed = true;
			}
			if (drag.mode === "move") moveBy(it, drag, dx, dy);
			else if (drag.mode === "resize") {
				const r = drag.rect;
				setRect(it, {
					...r,
					width: clamp(r.width + dx, 1, limit.w - r.col),
					depth: clamp(r.depth + dy, 1, limit.h - r.row),
				});
			} else if (drag.poly) {
				wall = -1;
				const r = dragOutline(drag.poly, drag, dx, dy);
				if (validOutline(r, limit)) {
					it.poly = r;
					writeOutline(it);
				}
			}
			draw();
		});
		const end = () => {
			const d = drag;
			drag = null;
			if (!d) return;
			if (d.moved) return draw();
			if (d.mode === "pan") select(null);
			else if (d.mode === "pick") select(d.it);
			else if (d.mode === "wall" && d.it) {
				wall = d.wall ?? -1;
				sayRoom(d.it, "selected");
				draw();
			}
		};
		svg.addEventListener("pointerup", end);
		svg.addEventListener("pointercancel", end);
		board.addEventListener(
			"wheel",
			(event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				const r = board.getBoundingClientRect();
				setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - r.left, event.clientY - r.top);
			},
			{ passive: false },
		);

		// The tools, the sections' buttons and the keyboard.
		form.querySelector("[data-plan-tools]")?.addEventListener("click", (event) => {
			const button = event.target instanceof Element ? event.target.closest("button") : null;
			if (!button) return;
			const kind = button.getAttribute("data-plan-add");
			const z = button.getAttribute("data-plan-zoom");
			if (kind) add(kind);
			else if (button.hasAttribute("data-plan-undo")) undo();
			else if (z === "in") setZoom(zoom * 1.25);
			else if (z === "out") setZoom(zoom / 1.25);
			else if (z === "fit") setZoom(fitZoom());
		});
		list.addEventListener("click", (event) => {
			const target = event.target instanceof Element ? event.target : null;
			const section = target?.closest("[data-plan-item]");
			const it = items.find((x) => x.section === section);
			if (!target || !it) return;
			if (target.closest("[data-plan-select]")) {
				select(it === selected ? null : it);
				if (selected) reveal(it);
			} else if (target.closest("[data-plan-rotate]")) rotate(it);
			else if (target.closest("[data-plan-remove]")) remove(it);
			else if (target.closest("[data-shape-preset]") && it.poly) {
				const b = outlineBox(it.poly);
				const preset = OUTLINE_PRESETS[target.closest("[data-shape-preset]")?.getAttribute("data-shape-preset") ?? ""];
				const r = preset ? normOutline(preset({ ...b, w: Math.max(3, b.w), h: Math.max(3, b.h) })) : null;
				if (!r || !validOutline(r, limit)) return;
				remember();
				touched(it);
				it.poly = r;
				writeOutline(it);
				wall = -1;
				sayRoom(it, "hint");
				draw();
			} else if (target.closest("[data-cut-step]") && it.poly) {
				if (wall < 0) return sayRoom(it, "pick");
				const r = cutOutline(it.poly, wall, step, limit);
				if (!r) return sayRoom(it, "short");
				remember();
				touched(it);
				it.poly = r;
				writeOutline(it);
				wall = -1;
				sayRoom(it, "cut");
				draw();
			}
		});
		// Typing a code, a name or the bins redraws the unit; a typed change counts as unsaved.
		form.addEventListener("input", (event) => {
			setDirty();
			const section = event.target instanceof Element ? event.target.closest("[data-plan-item]") : null;
			touched(items.find((it) => it.section === section));
			draw();
		});
		form.addEventListener("change", () => draw());
		document.addEventListener("keydown", (event) => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
			if (typing) return;
			if (event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
				event.preventDefault();
				undo();
				return;
			}
			if (!selected) return;
			const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
			const dir = arrows[event.key];
			const by = event.shiftKey ? step : 1;
			if (dir) {
				event.preventDefault();
				nudge(dir[0] * by, dir[1] * by);
			} else if (event.key === "Escape") select(null);
			else if ((event.key === "Delete" || event.key === "Backspace") && selected.isNew) {
				event.preventDefault();
				remove(selected);
			}
		});
		window.addEventListener("resize", () => draw());

		// A refused save comes back with its first unit in error selected; ?select=u12_ opens on a unit.
		const asked = new URLSearchParams(window.location.search).get("select");
		select(
			items.find((it) => it.section.dataset.invalid === "true") ?? items.find((it) => it.prefix === asked) ?? null,
		);
		if (selected) reveal(selected);
		if (form.querySelector("[data-plan-item][data-invalid]") || items.some((it) => it.isNew)) setDirty();
	}

	// Bins preview of the plan editor (<div data-bins-preview data-form="…" data-range="Bins {from} to {to}.">): the grid
	// of levels × positions and the first and last bin codes, redrawn as the fields change.
	for (const preview of document.querySelectorAll("[data-bins-preview]")) {
		const form = document.getElementById(preview.dataset.form ?? "");
		const svg = preview.querySelector("[data-bins-svg]");
		const text = preview.querySelector("[data-bins-text]");
		if (!(form instanceof HTMLFormElement) || !(svg instanceof SVGElement)) continue;
		const NS = "http://www.w3.org/2000/svg";
		const count = (name, max) => {
			const n = Number.parseInt(fieldValue(form, name), 10);
			return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : 1;
		};
		const redraw = () => {
			const levels = count("levels", 20);
			const positions = count("positions", 30);
			svg.setAttribute("viewBox", `0 0 ${positions * 22 + 2} ${levels * 14 + 2}`);
			const cells = [];
			for (let i = 0; i < levels * positions; i++) {
				const rect = document.createElementNS(NS, "rect");
				for (const [k, v] of Object.entries({
					x: (i % positions) * 22 + 1,
					y: Math.floor(i / positions) * 14 + 1,
					width: 20,
					height: 12,
					rx: 2,
					class: "fill-card stroke-foreground/40",
				}))
					rect.setAttribute(k, String(v));
				cells.push(rect);
			}
			svg.replaceChildren(...cells);
			const code = fieldValue(form, "code").toUpperCase() || "?";
			if (text)
				text.textContent = (preview.dataset.range ?? "")
					.replace("{from}", `${code}-1-1`)
					.replace("{to}", `${code}-${levels}-${positions}`);
		};
		form.addEventListener("input", redraw);
		form.addEventListener("change", redraw);
	}

	// <input type="file" data-image-input>: photos are shrunk in the browser before upload (longest side
	// 1600 px, WebP, or JPEG where WebP cannot be encoded), so a tablet's camera picture weighs a few hundred
	// KB instead of several MB. On any failure the original file is sent; the server checks it anyway.
	const MAX_SIDE = 1600;
	const shrink = async (file) => {
		if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return null;
		// Camera photos carry their rotation in EXIF: apply it (ignored where the option is unknown).
		const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
		const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		if (scale === 1 && file.size <= 1_000_000) {
			bitmap.close();
			return null;
		}
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close();
		const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
		let blob = await encode("image/webp");
		if (blob?.type !== "image/webp") {
			// JPEG has no transparency: paint white behind the picture.
			ctx.globalCompositeOperation = "destination-over";
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			blob = await encode("image/jpeg");
		}
		if (!blob || blob.size >= file.size) return null;
		const name = `${file.name.replace(/\.[^.]*$/, "")}.${blob.type === "image/webp" ? "webp" : "jpg"}`;
		return new File([blob], name, { type: blob.type });
	};

	document.addEventListener("change", async (event) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || input.dataset.imageInput === undefined) return;
		const file = input.files?.[0];
		if (!file) return;
		// Not sendable while the picture is being shrunk.
		const submit = input.form?.querySelector("button:not([type]), button[type='submit']");
		if (submit) submit.disabled = true;
		try {
			const smaller = await shrink(file);
			if (smaller && typeof DataTransfer === "function") {
				const transfer = new DataTransfer();
				transfer.items.add(smaller);
				input.files = transfer.files;
			}
		} catch {
			// Keep the original file.
		} finally {
			if (submit) submit.disabled = false;
		}
	});

	// <input type="file" data-max-bytes data-too-large>: a file over the server's limit (D161) is refused before a long
	// upload starts, with the server's own message.
	document.addEventListener("change", (event) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || input.dataset.maxBytes === undefined) return;
		const file = input.files?.[0];
		const tooLarge = file !== undefined && file.size > Number(input.dataset.maxBytes);
		input.setCustomValidity(tooLarge ? (input.dataset.tooLarge ?? "") : "");
		if (tooLarge) input.reportValidity();
	});

	// MoreMenu: CSS anchors the menu to its "⋯" button. A browser without CSS anchor positioning gets the same place
	// from the button's rectangle (CSSOM, not a style attribute: the CSP allows it).
	if (!CSS.supports("position-area", "bottom")) {
		document.addEventListener(
			"toggle",
			(event) => {
				const menu = event.target;
				if (
					!(menu instanceof HTMLElement) ||
					menu.dataset.slot !== "dropdown-menu-content" ||
					event.newState !== "open"
				)
					return;
				const trigger = document.querySelector(`[popovertarget="${menu.id}"]`);
				if (!trigger) return;
				const rect = trigger.getBoundingClientRect();
				menu.style.inset = `${rect.bottom}px ${document.documentElement.clientWidth - rect.right}px auto auto`;
			},
			true,
		);
	}

	// <div popover data-open>: a dialog the page shows on load, e.g. back from a refused upload with the reason inside.
	for (const dialog of document.querySelectorAll("[popover][data-open]")) {
		if (dialog instanceof HTMLElement && typeof dialog.showPopover === "function") dialog.showPopover();
	}

	// <button data-live-submit>: the submit button of a live filter bar (htmx refreshes the results as you type or
	// change a filter), so it is redundant once htmx is there. Without JavaScript it stays and submits the form.
	if (window.htmx) {
		for (const button of document.querySelectorAll("[data-live-submit]")) button.hidden = true;
	}

	// <form data-save-when-changed>: a small form inside a list (a user's role) shows its Save button only once a field
	// differs from the saved value, so the list is not a column of buttons. Without JavaScript the button is always there.
	const differs = (el) =>
		el instanceof HTMLSelectElement
			? [...el.options].some((o) => o.selected !== o.defaultSelected)
			: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
				el.type !== "hidden" &&
				el.value !== el.defaultValue;
	for (const form of document.querySelectorAll("form[data-save-when-changed]")) {
		if (!(form instanceof HTMLFormElement)) continue;
		const update = () => {
			const changed = [...form.elements].some(differs);
			for (const button of form.querySelectorAll("button")) button.hidden = !changed;
		};
		form.addEventListener("input", update);
		form.addEventListener("change", update);
		// Back from the next page (bfcache), the select may still hold the role picked before leaving.
		window.addEventListener("pageshow", update);
		update();
	}

	// <form data-upload-form data-busy="Uploading…">: a large file takes a while on the workshop's Wi-Fi, so the
	// button says so and cannot send it twice.
	const busyButtons = [];
	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.dataset.uploadForm === undefined) return;
		const button = form.querySelector("button:not([type]), button[type='submit']");
		if (!button) return;
		const label = [...button.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
		busyButtons.push({ button, label, text: label?.textContent ?? "" });
		if (label && form.dataset.busy) label.textContent = form.dataset.busy;
		// Disabled after the event, so the submission it started goes on.
		setTimeout(() => {
			button.disabled = true;
		});
	});
	// Back from the next page (bfcache): the buttons work again.
	window.addEventListener("pageshow", () => {
		for (const { button, label, text } of busyButtons.splice(0)) {
			button.disabled = false;
			if (label) label.textContent = text;
		}
	});

	// Part picker (D138): a field with a hidden [data-picker-open] "Browse" button and a <dialog data-part-picker>
	// next to its form. Where <dialog> works, the button appears and the datalist is dropped (it would fight the
	// dialog); results are loaded by htmx from /parts/pick. A [data-pick] result writes its reference into the field
	// (its id for a <select>), fires input and change, closes the dialog and moves on to the next field.
	const enhancePickers = (root) => {
		if (!(root instanceof Element || root instanceof Document)) return;
		for (const button of root.querySelectorAll("[data-picker-open]")) {
			const dialog = document.getElementById(button.dataset.pickerOpen);
			if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function") continue;
			const field = document.getElementById(dialog.dataset.target);
			if (field instanceof HTMLInputElement) {
				field.removeAttribute("list");
				field.autocomplete = "off";
			}
			button.hidden = false;
		}
	};
	enhancePickers(document);
	// The line forms are swapped by htmx: enhance what arrives.
	document.addEventListener("htmx:load", (event) => enhancePickers(event.target));

	const focusAfter = (target) => {
		const controls = target.form ? [...target.form.elements] : [];
		for (const next of controls.slice(controls.indexOf(target) + 1)) {
			if (
				!(next instanceof HTMLInputElement || next instanceof HTMLSelectElement || next instanceof HTMLTextAreaElement)
			)
				continue;
			if (next.type === "hidden" || next.disabled) continue;
			next.focus();
			// Typing replaces a prefilled quantity instead of appending to it ("1" + "2" would give 12).
			if (next instanceof HTMLInputElement) next.select();
			return;
		}
	};

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;
		const open = event.target.closest("[data-picker-open]");
		if (open instanceof HTMLElement) {
			const dialog = document.getElementById(open.dataset.pickerOpen);
			if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
			dialog.showModal();
			const search = dialog.querySelector('input[type="search"]');
			if (search instanceof HTMLInputElement) {
				search.focus();
				// Load the first page (the "search" event is one of the input's htmx triggers).
				window.htmx?.trigger(search, "search");
			}
			return;
		}
		const dialog = event.target.closest("dialog[data-part-picker]");
		// A click on the backdrop lands on the dialog itself.
		if (event.target === dialog || event.target.closest("[data-picker-close]")) {
			dialog?.close();
			return;
		}
		const pick = event.target.closest("[data-pick]");
		if (!(pick instanceof HTMLElement) || !(dialog instanceof HTMLDialogElement)) return;
		const target = document.getElementById(dialog.dataset.target);
		if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
		target.value = target instanceof HTMLSelectElement ? pick.dataset.pickId : pick.dataset.pick;
		target.dispatchEvent(new Event("input", { bubbles: true }));
		target.dispatchEvent(new Event("change", { bubbles: true }));
		dialog.close();
		focusAfter(target);
	});

	// "/" or Ctrl/Cmd+K: jump to the global search.
	document.addEventListener("keydown", (event) => {
		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
		const slash = event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey;
		const cmdK = event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
		if (!slash && !cmdK) return;
		event.preventDefault();
		const input = document.getElementById("global-search");
		if (input instanceof HTMLInputElement && input.offsetParent !== null) {
			input.focus();
			input.select();
		} else window.location.href = "/search";
	});
})();
