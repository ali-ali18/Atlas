// V4 — "o que mudou" depois de uma ação: digest da página antes/depois e diff
// puro. O digest roda DENTRO da página (serializado pelo Playwright, sem
// closure externa); o diff e o resumo são puros e testáveis sem navegador.
//
// `readDigestInPage` roda em UM frame (e atravessa shadow roots abertos);
// `readDigest` junta o frame principal e os iframes num digest só.

export const ADDED_MAX_CHARS = 1000;
export const BLOCK_MAX_CHARS = 160;
export const STATES_MAX = 8;
export const DIALOGS_MAX = 3;
export const ERRORS_MAX = 5;

/** Roda NA página: fatos brutos (texto por bloco, estados aria, diálogos, refs visíveis, erros). */
export function readDigestInPage() {
	const BLOCK_MAX = 160;
	// Teto de CONTEÚDO útil (nó de texto não vazio, em bloco visível), não de nós
	// percorridos: espaço em branco e conteúdo oculto não gastam o orçamento.
	const MAX_TEXT_NODES = 6000;
	const MAX_VISITED = 150000;
	const MAX_BLOCKS = 1200;
	const MAX_STATES = 300;
	const MAX_REFS = 600;
	const ATTR = "data-atlas-ref";

	if (!window.__atlasDoc) window.__atlasDoc = Math.random().toString(36).slice(2);
	const sids = window.__atlasSid || (window.__atlasSid = { map: new WeakMap(), n: 0 });
	const sidOf = (el) => {
		let id = sids.map.get(el);
		if (!id) {
			id = ++sids.n;
			sids.map.set(el, id);
		}
		return id;
	};
	// Shadow roots abertos: querySelectorAll sozinho não entra neles.
	const roots = [document];
	for (let i = 0; i < roots.length && roots.length < 200; i += 1) {
		for (const host of roots[i].querySelectorAll("*")) if (host.shadowRoot) roots.push(host.shadowRoot);
	}
	const deepAll = (selector) => roots.flatMap((r) => Array.from(r.querySelectorAll(selector)));
	const clip = (value, max) => {
		const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	};

	const renderedCache = new Map();
	const clippedCache = new Map();
	// Acordeão fechado costuma ser `height:0; overflow:hidden`: o filho tem
	// caixa, mas o ancestral o corta. Sobe poucos níveis procurando o corte.
	const clippedAway = (el) => {
		let a = el.parentElement;
		for (let i = 0; a && i < 8; i += 1, a = a.parentElement) {
			let cut = clippedCache.get(a);
			if (cut === undefined) {
				const style = getComputedStyle(a);
				cut = false;
				if (style.overflowX !== "visible" || style.overflowY !== "visible") {
					const r = a.getBoundingClientRect();
					cut = r.height < 1 || r.width < 1;
				}
				clippedCache.set(a, cut);
			}
			if (cut) return true;
		}
		return false;
	};
	const rendered = (el) => {
		const cached = renderedCache.get(el);
		if (cached !== undefined) return cached;
		let ok = true;
		if (typeof el.checkVisibility === "function") {
			ok = el.checkVisibility({ visibilityProperty: true });
		}
		if (ok) {
			const r = el.getBoundingClientRect();
			ok = r.width > 0 && r.height > 0 && !clippedAway(el);
		}
		renderedCache.set(el, ok);
		return ok;
	};

	// Geometria da viewport: o texto que está na tela entra primeiro (e é o que o
	// teto preserva), o resto segue em ordem de documento. Critério estrutural.
	const vw = window.innerWidth || document.documentElement.clientWidth || 0;
	const vh = window.innerHeight || document.documentElement.clientHeight || 0;
	const rectInView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
	const inViewCache = new Map();
	const inView = (el) => {
		let v = inViewCache.get(el);
		if (v === undefined) {
			v = rectInView(el.getBoundingClientRect());
			inViewCache.set(el, v);
		}
		return v;
	};

	// UMA caminhada em ordem de documento classifica cada bloco em "tela" (dialog/aside
	// visíveis + o que intersecta a viewport) ou "resto". Cada nó é contado UMA vez em
	// `visited`: o teto de tempo (MAX_VISITED) vale para a página, não por passada.
	const front = [];
	const rest = [];
	const byBlock = new Map();
	const blockOfCache = new Map();
	const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "OPTION"]);
	const seenText = new WeakSet(); // só os nós lidos pela passada de painéis (A)
	let usefulFront = 0;
	let usefulRest = 0;
	let visited = 0;
	let restFull = false; // o balde "resto" não aceita mais nada: só a tela ainda interessa
	const blockOf = (parent) => {
		let block = blockOfCache.get(parent);
		if (block) return block;
		block = parent;
		while (block && block !== document.body) {
			const display = getComputedStyle(block).display;
			if (display !== "inline" && display !== "contents") break;
			block = block.parentElement;
		}
		block = block || parent;
		blockOfCache.set(parent, block);
		return block;
	};
	const scan = (textRoot, forceFront) => {
		const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!forceFront && seenText.has(node)) continue;
			visited += 1;
			if (visited > MAX_VISITED) return;
			if (forceFront) seenText.add(node);
			const raw = node.nodeValue;
			if (!raw || !/\S/.test(raw)) continue;
			const parent = node.parentElement;
			if (!parent || skip.has(parent.tagName)) continue;
			// Balde "resto" cheio: só o que está na tela ainda pode entrar. Rejeita barato
			// (uma geometria) o pai fora da tela; caixa sem tamanho segue o caminho completo.
			if (restFull && !forceFront) {
				const pr = parent.getBoundingClientRect();
				if (pr.width > 0 && pr.height > 0 && !rectInView(pr)) continue;
			}
			const block = blockOf(parent);
			let entry = byBlock.get(block);
			if (entry === undefined) {
				if (!rendered(block)) {
					byBlock.set(block, null);
					continue;
				}
				const onScreen = forceFront || inView(block);
				const bucket = onScreen ? front : rest;
				if (bucket.length >= MAX_BLOCKS) {
					byBlock.set(block, null);
					if (!onScreen) restFull = true;
					continue;
				}
				entry = { text: "", onScreen };
				byBlock.set(block, entry);
				bucket.push(entry);
				if (!onScreen && rest.length >= MAX_BLOCKS) restFull = true;
			}
			if (!entry) continue;
			if (entry.onScreen) {
				if (usefulFront >= MAX_TEXT_NODES) continue;
				usefulFront += 1;
			} else {
				if (usefulRest >= MAX_TEXT_NODES) {
					restFull = true;
					continue;
				}
				usefulRest += 1;
			}
			entry.text += ` ${raw}`;
		}
	};
	const textRoots = [document.body || document.documentElement, ...roots.slice(1)];
	// Painéis e diálogos visíveis na tela entram primeiro.
	const priority = deepAll('dialog[open],aside,[role="complementary"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]').filter(
		(el) => rendered(el) && inView(el),
	);
	for (const el of priority) scan(el, true);
	for (const textRoot of textRoots) scan(textRoot, false);
	const blocks = [...front, ...rest.slice(0, Math.max(0, MAX_BLOCKS - front.length))];

	const states = [];
	const stateAttrs = ["aria-expanded", "aria-checked", "aria-selected", "aria-pressed"];
	for (const el of deepAll("[aria-expanded],[aria-checked],[aria-selected],[aria-pressed],details")) {
		if (states.length >= MAX_STATES) break;
		let kind = "";
		let value = "";
		if (el.tagName === "DETAILS") {
			kind = "expanded";
			value = String(el.open);
		} else {
			const attr = stateAttrs.find((name) => el.hasAttribute(name));
			if (!attr) continue;
			kind = attr.slice(5);
			value = el.getAttribute(attr);
		}
		const host = el.tagName === "DETAILS" ? el.querySelector("summary") || el : el;
		if (!rendered(host)) continue;
		states.push({
			id: sidOf(el),
			ref: el.getAttribute(ATTR) || "",
			name: clip(el.getAttribute("aria-label") || host.innerText || host.textContent, 50),
			kind,
			value,
		});
	}

	const dialogs = [];
	for (const el of deepAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]')) {
		if (dialogs.length >= 5 || !rendered(el)) continue;
		const labelled = (el.getAttribute("aria-labelledby") || "")
			.split(/\s+/)
			.map((id) => (id ? document.getElementById(id)?.textContent || "" : ""))
			.join(" ");
		const heading = el.querySelector("h1,h2,h3,[role=heading]");
		dialogs.push({
			id: sidOf(el),
			title: clip(el.getAttribute("aria-label") || labelled || heading?.textContent || el.innerText, 60),
		});
	}

	const refs = [];
	for (const el of deepAll(`[${ATTR}]`)) {
		if (refs.length >= MAX_REFS) break;
		if (rendered(el)) refs.push(el.getAttribute(ATTR));
	}

	// Erros de validação: campo inválido ou alerta DENTRO de formulário/diálogo.
	// Banner global de acessibilidade (role=alert fora de form) não conta.
	const errors = [];
	const addError = (text) => {
		const t = clip(text, 140);
		if (t && !errors.includes(t)) errors.push(t);
	};
	for (const el of deepAll('[role="alert"], .invalid-feedback, .field-error, .error-message')) {
		if (!rendered(el)) continue;
		const inForm = el.closest('form, [role="form"], dialog, [role="dialog"]');
		const styled = el.matches(".invalid-feedback, .field-error, .error-message");
		if (inForm || styled) addError(el.textContent);
	}
	let invalid = [];
	try {
		invalid = [...document.querySelectorAll('[aria-invalid="true"], :user-invalid')];
	} catch {
		invalid = [...document.querySelectorAll('[aria-invalid="true"]')];
	}
	for (const el of invalid) {
		if (!rendered(el)) continue;
		const name = el.getAttribute("aria-label") || el.name || el.id || el.tagName.toLowerCase();
		addError(`${name}: ${el.validationMessage || "invalid value"}`);
	}

	return {
		doc: window.__atlasDoc,
		url: location.href,
		title: document.title,
		blocks: blocks.map((entry) => clip(entry.text, BLOCK_MAX)).filter(Boolean),
		states,
		dialogs,
		refs,
		errors: errors.slice(0, 20),
	};
}

const validDigest = (digest) => digest && typeof digest === "object" && Array.isArray(digest.blocks);

/**
 * Lê o digest; `null` se a página navegou no meio ou não respondeu. Com
 * `registry`, soma o digest de cada iframe (mesmo ou outro origin): o texto
 * novo de um frame entra no "o que mudou". Frame inacessível é ignorado.
 */
export async function readDigest(page, registry) {
	let digest;
	try {
		digest = await page.evaluate(readDigestInPage);
	} catch {
		return null;
	}
	if (!validDigest(digest)) return null;
	if (!registry) return digest;
	for (const entry of registry.list(page)) {
		if (entry.main) continue;
		let part;
		try {
			part = await entry.frame.evaluate(readDigestInPage);
		} catch {
			continue;
		}
		if (!validDigest(part)) continue;
		digest.blocks.push(...part.blocks);
		// Os ids de estado/diálogo são por frame: o prefixo evita colisão.
		digest.states.push(...part.states.map((state) => ({ ...state, id: `${entry.prefix}:${state.id}` })));
		digest.dialogs.push(...part.dialogs.map((dialog) => ({ ...dialog, id: `${entry.prefix}:${dialog.id}` })));
		digest.refs.push(...part.refs);
		digest.errors.push(...part.errors);
	}
	return digest;
}

const stateLabel = (state) => {
	const who = [state.ref, state.name ? JSON.stringify(state.name) : ""].filter(Boolean).join(" ");
	return who;
};

/**
 * Diferença pura entre dois digests. `null` quando falta um dos lados.
 * Navegação completa (documento novo) não compara texto: a página é outra.
 */
export function diffPageDigest(before, after) {
	if (!before || !after) return null;
	const out = {
		reloaded: before.doc !== after.doc,
		urlChanged: before.url !== after.url,
		titleChanged: before.title !== after.title,
		title: after.title,
		added: [],
		removedBlocks: 0,
		states: [],
		dialogsOpened: [],
		dialogsClosed: [],
		reappeared: [],
		errors: [],
	};
	if (out.reloaded) return out;

	const counts = new Map();
	for (const text of before.blocks) counts.set(text, (counts.get(text) ?? 0) + 1);
	for (const text of after.blocks) {
		const left = counts.get(text) ?? 0;
		if (left > 0) counts.set(text, left - 1);
		else out.added.push(text);
	}
	for (const left of counts.values()) out.removedBlocks += left;

	const prior = new Map(before.states.map((state) => [state.id, state]));
	for (const state of after.states) {
		const was = prior.get(state.id);
		if (was && was.value !== state.value) {
			out.states.push(`${stateLabel(state)} ${state.kind} ${was.value}→${state.value}`.trim());
		}
	}

	const dialogsBefore = new Set(before.dialogs.map((dialog) => dialog.id));
	const dialogsAfter = new Set(after.dialogs.map((dialog) => dialog.id));
	out.dialogsOpened = after.dialogs.filter((dialog) => !dialogsBefore.has(dialog.id)).map((dialog) => dialog.title || "(untitled)");
	out.dialogsClosed = before.dialogs.filter((dialog) => !dialogsAfter.has(dialog.id)).map((dialog) => dialog.title || "(untitled)");

	const refsBefore = new Set(before.refs);
	out.reappeared = after.refs.filter((ref) => !refsBefore.has(ref));

	const errorsBefore = new Set(before.errors);
	out.errors = after.errors.filter((error) => !errorsBefore.has(error)).slice(0, ERRORS_MAX);
	return out;
}

/**
 * Resumo compacto do diff para o fio (JSON pequeno): texto novo com teto duro,
 * estados, diálogos. Sem campos vazios.
 */
export function summarizeChanges(diff, { maxChars = ADDED_MAX_CHARS } = {}) {
	if (!diff) return undefined;
	const changes = {};
	if (diff.reloaded) changes.reloaded = true;
	if (diff.titleChanged && diff.title) changes.title = diff.title;
	if (diff.added.length > 0) {
		let text = "";
		let shown = 0;
		for (const block of diff.added) {
			const next = text ? `${text} | ${block}` : block;
			if (next.length > maxChars) {
				const room = maxChars - text.length - (text ? 3 : 0);
				if (room > 20) text = text ? `${text} | ${block.slice(0, room - 1)}…` : `${block.slice(0, room - 1)}…`;
				break;
			}
			text = next;
			shown += 1;
		}
		changes.added = text;
		changes.addedBlocks = diff.added.length;
		const total = diff.added.reduce((sum, block) => sum + block.length + 3, -3);
		if (shown < diff.added.length || total > maxChars) changes.addedTotalChars = total;
	}
	if (diff.removedBlocks > 0) changes.removedBlocks = diff.removedBlocks;
	if (diff.states.length > 0) changes.states = diff.states.slice(0, STATES_MAX);
	if (diff.dialogsOpened.length > 0) changes.dialogsOpened = diff.dialogsOpened.slice(0, DIALOGS_MAX);
	if (diff.dialogsClosed.length > 0) changes.dialogsClosed = diff.dialogsClosed.slice(0, DIALOGS_MAX);
	return changes;
}
