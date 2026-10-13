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
