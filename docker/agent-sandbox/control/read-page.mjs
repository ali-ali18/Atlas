// V5 — leitura da página inteira. `readPageInPage` roda DENTRO de um frame
// (serializado pelo Playwright, sem closures): percorre o DOM na ordem de
// leitura, atravessa shadow roots abertos e emite itens simples. A montagem,
// o texto final e a busca ficam em outline.mjs (puro).
//
// Os elementos interativos já devem ter `data-atlas-ref` (collectInteractive
// em modo "all" roda antes); aqui eles só viram um item {t:"i", ref}.
//
// Ordem: o que está na tela vem primeiro. Passada A = dialog/aside/complementary
// visíveis na viewport; B = subárvores que intersectam a viewport; C = o resto,
// na ordem do documento. O critério é estrutural (geometria e visibilidade),
// sem seletor de site: uma página com 15 mil comentários antes do painel
// lateral ainda entrega o painel no começo da leitura.
//
// O teto é de CONTEÚDO ÚTIL (caracteres e itens emitidos). Texto vazio e nó
// oculto não gastam o orçamento; `READ_MAX_NODES` é só a trava de tempo.

export const READ_MAX_NODES = 150_000;
export const READ_MAX_ITEMS = 12_000;
export const READ_MAX_CHARS = 200_000;

export function readPageInPage(options) {
	const MAX_NODES = options?.maxNodes ?? 150000;
	const MAX_ITEMS = options?.maxItems ?? 12000;
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
	const vw = window.innerWidth || document.documentElement.clientWidth || 0;
	const vh = window.innerHeight || document.documentElement.clientHeight || 0;
	const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
	// `done`: nó já lido por inteiro (nas passadas seguintes é pulado).
	// `emitted`: o próprio elemento já gerou seu item (ref/landmark), mesmo que os filhos faltem.
	const done = new WeakSet();
	const emitted = new WeakSet();
	let pass = "C";
	let passChars = MAX_CHARS;
	let stop = false;

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

	// Devolve true se leu todos os filhos (nenhum ficou para outra passada).
	const walkChildren = (parent, depth) => {
		let complete = true;
		for (const child of parent.childNodes) {
			if (!walk(child, depth)) complete = false;
			if (truncated || stop) return false;
		}
		return complete;
	};

	// Trava global (conteúdo útil ou tempo) ou orçamento da passada atual.
	const exhausted = () => {
		if (nodes >= MAX_NODES || chars >= MAX_CHARS || items.length >= MAX_ITEMS) {
			truncated = true;
			return true;
		}
		if (chars >= passChars) {
			stop = true;
			return true;
		}
		return false;
	};

	// Retorna true quando o nó foi lido por inteiro (ou não há o que ler nele).
	function walk(node, depth) {
		if (done.has(node)) return true;
		if (truncated || stop || exhausted()) return false;
		nodes += 1;
		if (node.nodeType === 3) {
			buf += ` ${node.nodeValue}`;
			done.add(node);
			return true;
		}
		if (node.nodeType !== 1 || depth > MAX_DEPTH) return true;
		const el = node;
		const tag = el.tagName.toUpperCase();
		if (SKIP.has(tag)) {
			done.add(el);
			return true;
		}
		const style = getComputedStyle(el);
		if (hiddenEl(el, style)) {
			done.add(el);
			return true;
		}
		// Passada B: o que está fora da viewport fica para a passada C.
		if (pass === "B" && style.display !== "contents") {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && !inView(r)) return false;
		}

		if (tag === "IFRAME" || tag === "FRAME") {
			flush();
			items.push({ t: "frame", mark: el.getAttribute(MARK) || "" });
			done.add(el);
			return true;
		}
		const role = el.getAttribute("role") || "";
		if (/^H[1-6]$/.test(tag) || role === "heading") {
			flush();
			const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Math.min(6, Math.max(1, Number(el.getAttribute("aria-level")) || 2));
			const own = el.getAttribute(REF);
			const inner = own || el.querySelector(`[${REF}]`)?.getAttribute(REF) || "";
			const text = clip(el.innerText || el.textContent, 200);
			if (text || inner) items.push({ t: "h", level, text, ...(inner ? { ref: inner } : {}) });
			done.add(el);
			return true;
		}
		const ref = el.getAttribute(REF);
		if (ref) {
			if (!emitted.has(el)) {
				emitted.add(el);
				flush();
				items.push({ t: "i", ref });
			}
			let complete = true;
			// Nome truncado em 100 caracteres: contêiner clicável com texto longo continua sendo lido.
			if (!FIELDS.has(tag) && clip(el.innerText || el.textContent, 400).length > 100) complete = walkChildren(el, depth + 1);
			if (complete) done.add(el);
			return complete;
		}
		if (tag === "DETAILS" && !el.open) {
			const summary = el.querySelector(":scope > summary");
			const complete = summary ? walk(summary, depth + 1) : true;
			if (complete) done.add(el);
			return complete;
		}
		if (tag === "TD" || tag === "TH") {
			if (buf.trim()) buf += " | ";
			const complete = walkChildren(el, depth + 1);
			if (complete) done.add(el);
			return complete;
		}
		if (tag === "BR") {
			flush();
			done.add(el);
			return true;
		}
		const landmark = LANDMARK_TAGS[tag] || LANDMARK_ROLES[role];
		const display = style.display;
		const block = display !== "inline" && display !== "contents" && !display.startsWith("inline");
		if (block) flush();
		if (landmark && !emitted.has(el)) {
			emitted.add(el);
			items.push({ t: "lm", name: landmark });
		}
		const isLi = tag === "LI" || role === "listitem";
		if (isLi) inLi += 1;
		let complete = true;
		if (tag === "SLOT" && typeof el.assignedNodes === "function") {
			const assigned = el.assignedNodes({ flatten: true });
			if (assigned.length > 0) {
				for (const child of assigned) if (!walk(child, depth + 1)) complete = false;
			} else complete = walkChildren(el, depth + 1);
		} else if (el.shadowRoot) {
			// Árvore achatada: o shadow é renderizado; o light DOM só aparece via <slot>.
			complete = walkChildren(el.shadowRoot, depth + 1);
		} else {
			complete = walkChildren(el, depth + 1);
		}
		if (block) flush();
		if (isLi) inLi -= 1;
		if (complete) done.add(el);
		return complete;
	}

	// Janela de leitura: dialog/aside/complementary visíveis na viewport (onde costuma
	// aparecer a resposta do que acabou de ser acionado).
	const PRIORITY = 'dialog[open],aside,[role="complementary"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
	function priorityRoots() {
		const scopes = [document];
		for (let i = 0; i < scopes.length && scopes.length < 200; i += 1) {
			for (const host of scopes[i].querySelectorAll("*")) if (host.shadowRoot) scopes.push(host.shadowRoot);
		}
		const found = [];
		for (const scope of scopes) {
			for (const el of scope.querySelectorAll(PRIORITY)) {
				if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.height > 0 && inView(r)) found.push(el);
			}
		}
		return found;
	}
	function runPass(name, share, body) {
		pass = name;
		stop = false;
		passChars = share >= 1 ? MAX_CHARS : Math.min(MAX_CHARS, chars + Math.floor(MAX_CHARS * share));
		body();
		flush();
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
		// A: painéis/diálogos na tela; B: o que intersecta a viewport; C: o resto, em ordem de documento.
		runPass("A", 0.4, () => {
			for (const root of priorityRoots()) if (!truncated && !stop) walk(root, 0);
		});
		runPass("B", 0.7, () => {
			walk(start, 0);
		});
		const restAt = items.length;
		if (!truncated) {
			runPass("C", 1, () => {
				walk(start, 0);
			});
		}
		// Só rotula quando a ordem mudou de fato (há conteúdo fora da tela depois do que está na tela).
		if (restAt > 0 && items.length > restAt) {
			items.splice(restAt, 0, { t: "lm", name: "rest of page" });
			items.unshift({ t: "lm", name: "on screen" });
		}
	}
	flush();
	return { items, truncated, nodes };
}
