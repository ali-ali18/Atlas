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

	const ignored = (el) => {
		try {
			return Boolean(el.closest(IGNORE));
		} catch {
			return false;
		}
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

	// Auto: bloco (ancestral não-inline) cujo texto mais variou de tamanho.
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
	const texts = new Map();
	const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
	let seen = 0;
	for (let node = walker.nextNode(); node && seen < MAX_TEXT_NODES; node = walker.nextNode()) {
		if (!/\S/.test(node.nodeValue || "")) continue;
		seen += 1;
		const parent = node.parentElement;
		if (!parent || SKIP.has(parent.tagName) || ignored(parent)) continue;
		const block = blockOf(parent);
		texts.set(block, `${texts.get(block) ?? ""} ${node.nodeValue}`);
	}
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
			// Texto que já mexeu: basta ficar quieto por quietMs. Nada mexeu ainda: dá tempo
			// (graceMs) para a resposta começar antes de concluir que ela está pronta.
			const quietFor = s.changed ? s.idleMs : elapsed;
			const need = s.changed ? quietMs : Math.max(quietMs, graceMs);
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
