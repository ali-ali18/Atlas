// V5 — leitura da página inteira. `readPageInPage` roda DENTRO de um frame
// (serializado pelo Playwright, sem closures): percorre o DOM na ordem de
// leitura, atravessa shadow roots abertos e emite itens simples. A montagem,
// o texto final e a busca ficam em outline.mjs (puro).
//
// Os elementos interativos já devem ter `data-atlas-ref` (collectInteractive
// em modo "all" roda antes); aqui eles só viram um item {t:"i", ref}.

export const READ_MAX_NODES = 12_000;
export const READ_MAX_CHARS = 200_000;

export function readPageInPage(options) {
	const MAX_NODES = options?.maxNodes ?? 12000;
	const MAX_CHARS = options?.maxChars ?? 200000;
	const MAX_DEPTH = 120;
	const REF = "data-atlas-ref";
	const MARK = "data-atlas-frame";
	const SKIP = new Set([
		"SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "SVG", "HEAD", "META", "LINK", "CANVAS", "VIDEO", "AUDIO", "OBJECT",
	]);
	const LANDMARK_TAGS = { MAIN: "main", NAV: "nav", HEADER: "header", FOOTER: "footer", ASIDE: "aside", FORM: "form", DIALOG: "dialog" };
	const LANDMARK_ROLES = {
		main: "main", navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside", dialog: "dialog", alertdialog: "dialog", search: "search",
	};
	const FIELDS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

	const items = [];
	let buf = "";
	let chars = 0;
	let nodes = 0;
	let truncated = false;
	let inLi = 0;

	const clip = (value, max) => {
		const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	};
	const flush = () => {
		const text = buf.replace(/\s+/g, " ").trim();
		buf = "";
		if (!text) return;
		chars += text.length;
		items.push({ t: "p", text: clip(text, 1500), ...(inLi > 0 ? { li: true } : {}) });
	};

	// Fechado por overflow (acordeão com height:0) ou por visibilidade/content-visibility.
	const hiddenEl = (el, style) => {
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
		if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return true;
		if (style.display !== "contents" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
			const r = el.getBoundingClientRect();
			if (r.height < 1 || r.width < 1) return true;
		}
		return false;
	};

	const walkChildren = (parent, depth) => {
		for (const child of parent.childNodes) {
			if (truncated) return;
			walk(child, depth);
		}
	};

	function walk(node, depth) {
		if (nodes >= MAX_NODES || chars >= MAX_CHARS) {
			truncated = true;
			return;
		}
		nodes += 1;
		if (node.nodeType === 3) {
			buf += ` ${node.nodeValue}`;
			return;
		}
		if (node.nodeType !== 1 || depth > MAX_DEPTH) return;
		const el = node;
		const tag = el.tagName.toUpperCase();
		if (SKIP.has(tag)) return;
		const style = getComputedStyle(el);
		if (hiddenEl(el, style)) return;

		if (tag === "IFRAME" || tag === "FRAME") {
			flush();
			items.push({ t: "frame", mark: el.getAttribute(MARK) || "" });
			return;
		}
		const role = el.getAttribute("role") || "";
		if (/^H[1-6]$/.test(tag) || role === "heading") {
			flush();
			const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Math.min(6, Math.max(1, Number(el.getAttribute("aria-level")) || 2));
			const own = el.getAttribute(REF);
			const inner = own || el.querySelector(`[${REF}]`)?.getAttribute(REF) || "";
			const text = clip(el.innerText || el.textContent, 200);
			if (text || inner) items.push({ t: "h", level, text, ...(inner ? { ref: inner } : {}) });
			return;
		}
		const ref = el.getAttribute(REF);
		if (ref) {
			flush();
			items.push({ t: "i", ref });
			// Nome truncado em 100 caracteres: contêiner clicável com texto longo continua sendo lido.
			if (!FIELDS.has(tag) && clip(el.innerText || el.textContent, 400).length > 100) walkChildren(el, depth + 1);
			return;
		}
		if (tag === "DETAILS" && !el.open) {
			const summary = el.querySelector(":scope > summary");
			if (summary) walk(summary, depth + 1);
			return;
		}
		if (tag === "TD" || tag === "TH") {
			if (buf.trim()) buf += " | ";
			walkChildren(el, depth + 1);
			return;
		}
		if (tag === "BR") {
			flush();
			return;
		}
		const landmark = LANDMARK_TAGS[tag] || LANDMARK_ROLES[role];
		const display = style.display;
		const block = display !== "inline" && display !== "contents" && !display.startsWith("inline");
		if (block) flush();
		if (landmark) items.push({ t: "lm", name: landmark });
		const isLi = tag === "LI" || role === "listitem";
		if (isLi) inLi += 1;
		if (tag === "SLOT" && typeof el.assignedNodes === "function") {
			const assigned = el.assignedNodes({ flatten: true });
			if (assigned.length > 0) for (const child of assigned) walk(child, depth + 1);
			else walkChildren(el, depth + 1);
		} else if (el.shadowRoot) {
			// Árvore achatada: o shadow é renderizado; o light DOM só aparece via <slot>.
			walkChildren(el.shadowRoot, depth + 1);
		} else {
			walkChildren(el, depth + 1);
		}
		if (block) flush();
		if (isLi) inLi -= 1;
	}

	// `panelOf`: lê só o painel controlado por um botão (acordeão), não a página.
	let start = document.body || document.documentElement;
	if (options?.panelOf) {
		const toggle = document.querySelector(`[${REF}="${options.panelOf}"]`) || null;
		const found = toggle ? panelOfToggle(toggle) : null;
		if (!found) return { items: [], truncated: false, nodes: 0, noPanel: true };
		start = found;
	}
	function panelOfToggle(toggle) {
		if (toggle.tagName === "SUMMARY") return toggle.parentElement;
		const root = toggle.getRootNode();
		const byId = (id) => (id ? root.getElementById?.(id) || document.getElementById(id) : null);
		const controls = (toggle.getAttribute("aria-controls") || "").split(/\s+/)[0];
		if (byId(controls)) return byId(controls);
		const href = toggle.getAttribute("href") || "";
		if (href.startsWith("#") && href.length > 1 && byId(href.slice(1))) return byId(href.slice(1));
		const target = toggle.getAttribute("data-target") || toggle.getAttribute("data-bs-target") || "";
		if (target.startsWith("#") && target.length > 1) return byId(target.slice(1));
		return null;
	}
	if (options?.panelOf) {
		if (hiddenEl(start, getComputedStyle(start))) return { items: [], truncated: false, nodes: 0, hidden: true };
		const summary = start.tagName === "DETAILS" ? start.querySelector(":scope > summary") : null;
		for (const child of start.childNodes) if (child !== summary) walk(child, 0);
	} else {
		walk(start, 0);
	}
	flush();
	return { items, truncated, nodes };
}
