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
		const parse = (text) => {
			const pts = (text ?? "")
				.trim()
				.split(/\s+/)
				.map((g) => g.split(",").map(Number));
			return pts.length >= 4 && pts.every((p) => p.length === 2 && p.every(Number.isInteger)) ? pts : null;
		};
		const area = (p) =>
			p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;
		// Drops repeated and in-line corners, and turns the outline clockwise on screen (the room on the right).
		const norm = (pts) => {
			const p = pts.map((q) => [q[0], q[1]]);
			for (let again = true; again && p.length >= 4; ) {
				again = false;
				for (let i = 0; i < p.length; i++) {
					const a = p[(i + p.length - 1) % p.length];
					const b = p[i];
					const c = p[(i + 1) % p.length];
					if (
						(b[0] === c[0] && b[1] === c[1]) ||
						(a[0] === b[0] && b[0] === c[0]) ||
						(a[1] === b[1] && b[1] === c[1])
					) {
						p.splice(i, 1);
						again = true;
						break;
					}
				}
			}
			if (area(p) < 0) p.reverse();
			return p;
		};
		// Walls along the grid that never cross or touch but at their ends, on the plan.
		const valid = (p) => {
			const n = p.length;
			if (n < 4 || area(p) <= 0) return false;
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
		const box = (p) => {
			const xs = p.map((q) => q[0]);
			const ys = p.map((q) => q[1]);
			const x = Math.min(...xs);
			const y = Math.min(...ys);
			return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
		};
		// Presets fill the room's current box: an L keeps the top and the left, a T a bar and a stem, a U two arms.
		const presets = {
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
			return presets.rect({ x, y, w, h });
		};
		const start = parse(svg.dataset.outline);
		let poly = start ? norm(start) : null;
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
			if (hidden instanceof HTMLInputElement) hidden.value = poly.map((q) => q.join(",")).join(" ");
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
				poly = norm(fromFields());
				if (hidden instanceof HTMLInputElement) hidden.value = poly.map((q) => q.join(",")).join(" ");
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
			for (let i = 0; i < n; i++) {
				const a = poly[i];
				const b = poly[(i + 1) % n];
				const flat = a[1] === b[1];
				const mx = ((a[0] + b[0]) / 2) * sq;
				const my = ((a[1] + b[1]) / 2) * sq;
				const g = add("g", { "data-wall": i, class: flat ? "cursor-ns-resize" : "cursor-ew-resize" });
				if (i === selected)
					add(
						"line",
						{
							x1: a[0] * sq,
							y1: a[1] * sq,
							x2: b[0] * sq,
							y2: b[1] * sq,
							"stroke-width": 4,
							class: "stroke-plan-accent",
						},
						g,
					);
				add(
					"line",
					{
						x1: a[0] * sq,
						y1: a[1] * sq,
						x2: b[0] * sq,
						y2: b[1] * sq,
						"stroke-width": coarse ? 32 : 16,
						class: "stroke-transparent",
					},
					g,
				);
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
				const moving =
					drag?.moved &&
					(drag.wall === i || (drag.corner !== undefined && (drag.corner === i || (drag.corner + n - 1) % n === i)));
				if (i === selected || moving) {
					const len = Math.abs(flat ? b[0] - a[0] : b[1] - a[1]);
					const label = add("text", {
						x: mx + (flat ? 0 : 14 * k),
						y: my + (flat ? -12 * k : 4 * k),
						"text-anchor": flat ? "middle" : "start",
						class: "pointer-events-none fill-plan-accent text-[11px] font-medium tabular-nums",
					});
					label.textContent = `${metres.format((len * squareCm) / 100)} m`;
				}
			}
			for (let i = 0; i < n; i++) {
				const g = add("g", { "data-corner": i, class: "cursor-move" });
				add(
					"circle",
					{ cx: poly[i][0] * sq, cy: poly[i][1] * sq, r: (coarse ? 24 : 12) * k, class: "fill-transparent" },
					g,
				);
				add(
					"circle",
					{
						cx: poly[i][0] * sq,
						cy: poly[i][1] * sq,
						r: 5 * k,
						"stroke-width": 1.5,
						class: "fill-background stroke-plan-accent",
					},
					g,
				);
			}
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
			const q = drag.from.map((v) => v.slice());
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
				// A corner drags the two walls that meet there: its neighbours follow on their own wall's line.
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
			const r = norm(q);
			if (valid(r)) poly = r;
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
		// A step: the second half of the selected wall moves into the room by about a metre (less when it would not fit).
		const cut = () => {
			if (selected < 0 || !poly) return say("pick");
			const n = poly.length;
			const a = poly[selected];
			const b = poly[(selected + 1) % n];
			const flat = a[1] === b[1];
			const len = Math.abs(flat ? b[0] - a[0] : b[1] - a[1]);
			const sx = Math.sign(b[0] - a[0]);
			const sy = Math.sign(b[1] - a[1]);
			const m = flat ? [a[0] + sx * Math.floor(len / 2), a[1]] : [a[0], a[1] + sy * Math.floor(len / 2)];
			for (let d = stepDepth; len >= 2 && d >= 1; d--) {
				const inward = [-sy * d, sx * d];
				const q = [
					...poly.slice(0, selected + 1),
					m,
					[m[0] + inward[0], m[1] + inward[1]],
					[b[0] + inward[0], b[1] + inward[1]],
					...poly.slice(selected + 1),
				];
				const r = norm(q);
				if (valid(r)) {
					commit(r, poly);
					selected = -1;
					say("cut");
					return draw();
				}
			}
			say("short");
		};
		for (const button of tools.querySelectorAll("[data-shape-preset]"))
			button.addEventListener("click", () => {
				if (!poly) return;
				const b = box(poly);
				const r = norm(
					presets[button.getAttribute("data-shape-preset")]({ ...b, w: Math.max(3, b.w), h: Math.max(3, b.h) }),
				);
				if (!valid(r)) return;
				commit(r, poly);
				selected = -1;
				say("hint");
				draw();
			});
		tools.querySelector("[data-cut-step]")?.addEventListener("click", cut);
		tools.querySelector("[data-shape-undo]")?.addEventListener("click", () => {
			const before = history.pop();
			if (!before) return;
			poly = before;
			// Back to the saved outline: nothing to post, the place fields hold it.
			const text = poly.map((q) => q.join(",")).join(" ");
			const saved = start
				? norm(start)
						.map((q) => q.join(","))
						.join(" ")
				: null;
			if (hidden instanceof HTMLInputElement) hidden.value = text === saved ? "" : text;
			selected = -1;
			say("hint");
			draw();
		});
		form.addEventListener("change", (event) => {
			// Until the outline is changed, switching to a room starts from the saved outline or the place fields.
			if (event.target instanceof HTMLInputElement && event.target.name === "kind" && !history.length)
				poly = start ? norm(start) : null;
			draw();
		});
		// The plain editor redraws its shapes as fields change: keep them hidden behind the outline.
		form.addEventListener("input", draw);
		// Handles are sized in screen pixels: a resized window changes the drawing's scale.
		window.addEventListener("resize", draw);
		draw();
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
