// `browser_wait for:"text_stable"` — espera o TEXTO de um alvo parar de mudar.
// Serve para respostas que chegam aos poucos (chat/painel de IA): o DOM de uma
// página com vídeo nunca fica quieto (stability.mjs), mas o texto da resposta
// para de crescer. Sem `ref`/`scope`, o alvo é o bloco de texto que mais mudou.
//
// Mutações de vídeo e de elementos de player (tempo, barra de progresso) ficam
// FORA da medida; o resto, como um relógio qualquer, não decide nada porque o
// alvo é escolhido pelo quanto o texto CRESCEU/ENCOLHEU, não pela contagem de
// mudanças.
import { splitRef } from "./frames.mjs";

export const TEXT_QUIET_MS = 1500;
// Texto que já cresceu: depois do silêncio de TEXT_QUIET_MS ainda se confirma por mais esta
// janela. Uma pausa de streaming (o modelo "pensando") maior que 1,5 s não encerra a espera.
export const TEXT_CONFIRM_MS = 1000;
// Sem ref/scope e sem nada mudando: dá tempo para a resposta começar antes de concluir "estável".
export const TEXT_NO_CHANGE_GRACE_MS = 3000;
export const TEXT_POLL_MS = 250;

/**
 * Roda NA página (serializado pelo Playwright, sem closure). Guarda estado em
 * `window` entre as chamadas e devolve o alvo e há quantos ms o texto dele não muda.
 * `opts`: { ref?, scope?, auto? } — com ref/scope mede esse elemento; com auto, o bloco que mais mudou.
 */
export function sampleTextInPage(opts) {
	const IGNORE =
		'video, audio, canvas, svg, [role="timer"], [role="progressbar"], [role="slider"], time, progress, meter, [class*="player" i], [id*="player" i]';
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "OPTION", "HEAD"]);
	const MAX_TEXT_NODES = 6000;
	// Cada espera começa do zero: texto estável de uma espera anterior não vale para esta.
	if (opts?.reset) delete window.__atlasTS;
	const state = window.__atlasTS || (window.__atlasTS = { start: performance.now(), blocks: new Map(), ids: new WeakMap(), n: 0, targets: new Map() });
	const now = performance.now();

	const ignoredCache = new Map();
	const ignored = (el) => {
		let hit = ignoredCache.get(el);
		if (hit === undefined) {
			try {
				hit = Boolean(el.closest(IGNORE));
			} catch {
				hit = false;
			}
			ignoredCache.set(el, hit);
		}
		return hit;
	};
	const textOf = (root) => {
		let out = "";
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let seen = 0;
		for (let node = walker.nextNode(); node && seen < MAX_TEXT_NODES; node = walker.nextNode()) {
			seen += 1;
			const parent = node.parentElement;
			if (!parent || SKIP.has(parent.tagName) || ignored(parent)) continue;
			out += ` ${node.nodeValue}`;
		}
		return out.replace(/\s+/g, " ").trim();
	};

	if (opts?.ref || opts?.scope) {
		let el = null;
		try {
			el = opts.ref ? document.querySelector(`[data-atlas-ref="${opts.ref}"]`) : document.querySelector(opts.scope);
		} catch {
			return { found: false };
		}
		if (!el) return { found: false };
		const key = opts.ref || opts.scope;
		const text = textOf(el);
		const prev = state.targets.get(key);
		if (!prev) state.targets.set(key, { text, last: now });
		else if (prev.text !== text) {
			prev.text = text;
			prev.last = now;
		}
		const entry = state.targets.get(key);
		return { found: true, idleMs: now - entry.last, len: text.length, changed: entry.last > state.start + 1 };
	}

	// Auto: bloco (ancestral não-inline) cujo texto mais variou de tamanho. Mede só o que
	// está renderizado (oculto não conta) e dá prioridade ao que está na tela e a
	// dialog/aside, como a leitura: uma resposta que chega num painel lateral, atrás de
	// 15 mil comentários, é vista. O resto da página vem depois, com teto próprio.
	const MAX_VISITED = 150000;
	const vw = window.innerWidth || document.documentElement.clientWidth || 0;
	const vh = window.innerHeight || document.documentElement.clientHeight || 0;
	const rectInView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
	const displayOf = new Map();
	const blockOf = (parent) => {
		let block = parent;
		while (block && block !== document.body) {
			let display = displayOf.get(block);
			if (display === undefined) {
				display = getComputedStyle(block).display;
				displayOf.set(block, display);
			}
			if (display !== "inline" && display !== "contents") break;
			block = block.parentElement;
		}
		return block || parent;
	};
	const texts = new Map(); // bloco -> { text, front } | null (oculto/ignorado)
	const seenText = new WeakSet(); // nós lidos pela passada de painéis
	let usedFront = 0;
	let usedRest = 0;
	let restFull = false;
	let visited = 0;
	const scan = (root, forceFront) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!forceFront && seenText.has(node)) continue;
			visited += 1;
			if (visited > MAX_VISITED) return;
			if (forceFront) seenText.add(node);
			if (!/\S/.test(node.nodeValue || "")) continue;
			const parent = node.parentElement;
			if (!parent || SKIP.has(parent.tagName) || ignored(parent)) continue;
			if (restFull && !forceFront) {
				const pr = parent.getBoundingClientRect();
				if (pr.width > 0 && pr.height > 0 && !rectInView(pr)) continue;
			}
			const block = blockOf(parent);
			let entry = texts.get(block);
			if (entry === undefined) {
				const shown = typeof block.checkVisibility !== "function" || block.checkVisibility({ visibilityProperty: true });
				const r = shown ? block.getBoundingClientRect() : null;
				if (!r || r.width <= 0 || r.height <= 0) {
					texts.set(block, null);
					continue;
				}
				entry = { text: "", front: forceFront || rectInView(r) };
				texts.set(block, entry);
			}
			if (!entry) continue;
			if (entry.front) {
				if (usedFront >= MAX_TEXT_NODES) continue;
				usedFront += 1;
			} else {
				if (usedRest >= MAX_TEXT_NODES) {
					restFull = true;
					continue;
				}
				usedRest += 1;
			}
			entry.text += ` ${node.nodeValue}`;
		}
	};
	const PRIORITY = 'dialog[open],aside,[role="complementary"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
	for (const el of document.querySelectorAll(PRIORITY)) {
		if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) continue;
		if (rectInView(el.getBoundingClientRect())) scan(el, true);
	}
	scan(document.body || document.documentElement, false);
	for (const [block, entry] of [...texts]) if (!entry) texts.delete(block);
	for (const [block, entry] of texts) texts.set(block, entry.text);
	let best = null;
	for (const [block, raw] of texts) {
		const text = raw.replace(/\s+/g, " ").trim();
		let id = state.ids.get(block);
		if (!id) {
			id = ++state.n;
			state.ids.set(block, id);
		}
		const prev = state.blocks.get(id);
		if (!prev) {
			state.blocks.set(id, { text, score: 0, last: now });
			continue;
		}
		if (prev.text !== text) {
			// Só o tamanho conta: um relógio que troca dígitos (mesmo tamanho) nunca vira o alvo.
			prev.score += Math.abs(text.length - prev.text.length);
			prev.text = text;
			prev.last = now;
		}
		if (prev.score > 0 && (!best || prev.score > best.score)) best = prev;
	}
	if (!best) return { found: true, changed: false, idleMs: now - state.start, len: 0 };
	return { found: true, changed: true, idleMs: now - best.last, len: best.text.length, score: best.score };
}

/**
 * Laço puro (relógio injetado). `sample()` devolve { found, idleMs, changed } já
 * somado entre os frames, ou null quando não deu para medir.
 */
export async function waitUntilTextStable({
	sample,
	quietMs = TEXT_QUIET_MS,
	confirmMs = TEXT_CONFIRM_MS,
	graceMs = TEXT_NO_CHANGE_GRACE_MS,
	capMs,
	pollMs = TEXT_POLL_MS,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const start = now();
	let last = { found: false, changed: false, len: 0 };
	for (;;) {
		const s = await sample();
		const elapsed = now() - start;
		if (s) last = s;
		if (s?.found) {
			// Texto que já mexeu: precisa de quietMs de silêncio + confirmMs de confirmação. Nada mexeu ainda: dá tempo
			// (graceMs) para a resposta começar antes de concluir que ela está pronta.
			const quietFor = s.changed ? s.idleMs : elapsed;
			const need = s.changed ? quietMs + confirmMs : Math.max(quietMs, graceMs);
			if (quietFor >= need) return { met: true, waitedMs: elapsed, changed: Boolean(s.changed), textLength: s.len ?? 0 };
		}
		if (elapsed >= capMs) {
			return {
				met: false,
				waitedMs: elapsed,
				changed: Boolean(last.changed),
				textLength: last.len ?? 0,
				reason: last.found ? `o texto continuou mudando por ${capMs} ms` : "alvo não encontrado na página",
			};
		}
		await sleep(Math.min(pollMs, capMs - elapsed));
	}
}

/** Mede em todos os frames (ou no do `ref`) e espera o texto estabilizar. Nunca lança por frame que sumiu. */
export async function waitForTextStable(page, registry, { ref, scope, timeoutMs, quietMs, now = Date.now, sleep } = {}) {
	const base = ref ? { ref } : scope ? { scope } : {};
	const hasTarget = Boolean(ref || scope);
	let first = true;
	const framesFor = () => {
		const list = registry.list(page);
		if (!ref) return list.map((entry) => entry.frame);
		const frame = registry.frameOf(page, splitRef(ref)?.prefix ?? "");
		return frame ? [frame] : [];
	};
	const sample = async () => {
		const opts = { ...base, reset: first };
		first = false;
		const parts = [];
		for (const frame of framesFor()) {
			try {
				const part = await frame.evaluate(sampleTextInPage, opts);
				if (part) parts.push(part);
			} catch {
				// frame navegando ou desanexado: ignora nesta rodada
			}
		}
		const found = parts.filter((part) => part.found);
		if (found.length === 0) return parts.length > 0 ? { found: false, changed: false, len: 0 } : null;
		// Alvo: o de maior variação; sem variação, o mais recente a mexer.
		const changed = found.filter((part) => part.changed);
		if (hasTarget) {
			const pick = found.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
			return { found: true, changed: Boolean(pick.changed), idleMs: pick.idleMs, len: pick.len };
		}
		if (changed.length === 0) return { found: true, changed: false, idleMs: Math.min(...found.map((part) => part.idleMs)), len: 0 };
		const pick = changed.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
		return { found: true, changed: true, idleMs: pick.idleMs, len: pick.len };
	};
	return waitUntilTextStable({ sample, quietMs, capMs: timeoutMs, now, sleep });
}
