// F12/A3 — espera de estabilidade depois de uma ação: navegação (se houver)
// + rede ociosa curta + DOM sem mutação por `quietMs`, com teto `capMs`.

export const QUIET_MS = 300;
export const CAP_MS = 4000;
const POLL_MS = 100;

/**
 * Roda NA página (serializado pelo Playwright). Instala um MutationObserver
 * na primeira chamada; devolve há quantos ms o DOM não muda.
 */
export function readIdleInPage() {
	if (!window.__atlasMut) {
		window.__atlasMut = { last: performance.now() };
		new MutationObserver(() => {
			window.__atlasMut.last = performance.now();
		}).observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		return 0;
	}
	return performance.now() - window.__atlasMut.last;
}

/**
 * Laço puro com relógio injetado. `readIdleMs()` devolve ms sem mutação, ou
 * `null` quando não deu para medir (página navegando): conta como instável.
 */
export async function waitUntilQuiet({
	readIdleMs,
	quietMs = QUIET_MS,
	capMs = CAP_MS,
	pollMs = POLL_MS,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const start = now();
	for (;;) {
		const idle = await readIdleMs();
		if (idle !== null && idle !== undefined && idle >= quietMs) {
			return { settled: true, waitedMs: now() - start };
		}
		const elapsed = now() - start;
		if (elapsed >= capMs) return { settled: false, waitedMs: elapsed };
		await sleep(Math.min(pollMs, capMs - elapsed));
	}
}

/**
 * Estabiliza `page` depois de uma ação. Nunca lança: o objetivo é informar
 * o efeito, não falhar a ação que já aconteceu.
 */
export async function stabilizePage(page, { urlBefore, capMs = CAP_MS, quietMs = QUIET_MS, now = Date.now, sleep } = {}) {
	const start = now();
	const remaining = () => Math.max(0, capMs - (now() - start));
	try {
		await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(remaining(), 3000)) });
	} catch {
		// Navegação lenta: o laço abaixo reporta settled=false.
	}
	try {
		await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(remaining(), 1000)) });
	} catch {
		// Polling/websocket mantém a rede ocupada: segue para o DOM.
	}
	const quiet = await waitUntilQuiet({
		readIdleMs: async () => {
			try {
				return await page.evaluate(readIdleInPage);
			} catch {
				return null;
			}
		},
		quietMs,
		capMs: remaining(),
		now,
		sleep,
	});
	let url = "";
	let title = "";
	try {
		url = page.url();
		title = await page.title();
	} catch {
		// Página fechou no meio: devolve o que tem.
	}
	return {
		url,
		title,
		navigated: urlBefore !== undefined && url !== urlBefore,
		settled: quiet.settled,
	};
}

// V1 — prontidão de conteúdo após `navigate`: SPA entrega o HTML vazio e
// monta o texto depois. Pronto = há texto (ou landmark com texto) e o
// tamanho do texto ficou estável por `stableMs`. Mede o TEXTO, não mutações
// do DOM (carrossel/anúncio mutam para sempre). Teto curto, sem networkidle.

export const READY_MIN_TEXT = 40;
export const READY_STABLE_MS = 300;
export const READY_CAP_MS = 5000;

/** Roda NA página: tamanho do texto visível e se há landmark com texto. */
export function readContentInPage() {
	const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
	let landmark = false;
	for (const el of document.querySelectorAll("main, [role=main], article, h1")) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0 && (el.innerText ?? "").trim().length > 0) {
			landmark = true;
			break;
		}
	}
	return { len: text.length, landmark };
}

/**
 * Laço puro (relógio injetado). `read()` devolve {len, landmark} ou null
 * (página navegando). `ready:false` quando o teto estoura.
 */
export async function waitUntilContentReady({
	read,
	minText = READY_MIN_TEXT,
	stableMs = READY_STABLE_MS,
	capMs = READY_CAP_MS,
	pollMs = POLL_MS,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const start = now();
	let lastLen = -1;
	let since = start;
	let len = 0;
	for (;;) {
		const sample = await read();
		const t = now();
		if (sample) {
			len = sample.len;
			if (sample.len !== lastLen) {
				lastLen = sample.len;
				since = t;
			}
			const hasContent = sample.len >= minText || (sample.landmark && sample.len > 0);
			if (hasContent && t - since >= stableMs) return { ready: true, waitedMs: t - start, textLength: len };
		}
		const elapsed = t - start;
		if (elapsed >= capMs) return { ready: false, waitedMs: elapsed, textLength: len };
		await sleep(Math.min(pollMs, capMs - elapsed));
	}
}

/** Prontidão pós-`goto`: nunca lança; devolve url/título + ready/readyMs. */
export async function waitForPageReady(page, { capMs = READY_CAP_MS, now = Date.now, sleep } = {}) {
	const result = await waitUntilContentReady({
		read: async () => {
			try {
				return await page.evaluate(readContentInPage);
			} catch {
				return null;
			}
		},
		capMs,
		now,
		sleep,
	});
	let url = "";
	let title = "";
	try {
		url = page.url();
		title = await page.title();
	} catch {
		// Página fechou no meio: devolve o que tem.
	}
	return { url, title, ready: result.ready, readyMs: result.waitedMs, textLength: result.textLength };
}

// V4 — espera adaptativa depois de uma ação. Em vez de `networkidle` (até 1 s
// parado em páginas com polling), mede o que importa: mutações do DOM, fetch/
// XHR em andamento e `aria-busy`. Clique sem efeito custa ~graceMs.

export const SETTLE_QUIET_MS = 250;
// Sem nenhuma mutação nem requisição desde o início da ação: janela menor.
export const SETTLE_GRACE_MS = 150;
export const SETTLE_CAP_MS = 3000;
const SETTLE_POLL_MS = 50;

/** Roda NA página (idempotente): observador de mutações + contador de fetch/XHR. */
export function installProbeInPage() {
	if (window.__atlasProbe) {
		window.__atlasProbe.armed = performance.now();
		return;
	}
	const probe = { last: performance.now(), mark: performance.now(), armed: performance.now(), inflight: 0 };
	window.__atlasProbe = probe;
	new MutationObserver((records) => {
		// A marcação `data-atlas-ref` é nossa: não conta como mudança da página.
		if (records.some((r) => r.type !== "attributes" || (r.attributeName !== "data-atlas-ref" && r.attributeName !== "data-atlas-frame"))) {
			probe.last = performance.now();
		}
	}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	const done = () => {
		probe.inflight = Math.max(0, probe.inflight - 1);
		probe.last = performance.now();
	};
	const nativeFetch = window.fetch;
	if (typeof nativeFetch === "function") {
		window.fetch = function patchedFetch(...args) {
			probe.inflight += 1;
			try {
				return nativeFetch.apply(this, args).finally(done);
			} catch (error) {
				done();
				throw error;
			}
		};
	}
	const nativeSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.send = function patchedSend(...args) {
		probe.inflight += 1;
		this.addEventListener("loadend", done, { once: true });
		return nativeSend.apply(this, args);
	};
}

/**
 * Roda NA página: estado de estabilidade. `mark` zera a janela de silêncio
 * (a ação acabou de acontecer). `fresh:true` = documento novo, sem sonda.
 */
export function readProbeInPage(mark) {
	const probe = window.__atlasProbe;
	if (!probe) {
		return { fresh: true };
	}
	const now = performance.now();
	if (mark) probe.mark = now;
	let busy = false;
	for (const el of document.querySelectorAll('[aria-busy="true"]')) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) {
			busy = true;
			break;
		}
	}
	return {
		idle: now - Math.max(probe.last, probe.mark),
		inflight: probe.inflight,
		busy,
		// Algo mexeu (DOM ou rede) desde que a ação começou?
		active: probe.last > probe.armed || probe.inflight > 0,
	};
}

/**
 * Laço puro (relógio injetado). `probe()` devolve {idle, inflight, busy},
 * {fresh:true} (documento novo) ou null (contexto destruído/navegando).
 * Resultado: settled | navigated (documento mudou) | timeout.
 */
export async function waitUntilSettled({
	probe,
	quietMs = SETTLE_QUIET_MS,
	graceMs = SETTLE_GRACE_MS,
	capMs = SETTLE_CAP_MS,
	pollMs = SETTLE_POLL_MS,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const start = now();
	for (let round = 0; ; round += 1) {
		const sample = await probe(round === 0);
		const elapsed = now() - start;
		if (sample === null || (sample.fresh && round > 0)) return { state: "navigated", waitedMs: elapsed };
		const need = sample.active === false ? graceMs : quietMs;
		if (!sample.fresh && sample.idle >= need && sample.inflight === 0 && !sample.busy) {
			return { state: "settled", waitedMs: elapsed };
		}
		if (elapsed >= capMs) return { state: "timeout", waitedMs: elapsed };
		await sleep(Math.min(pollMs, capMs - elapsed));
	}
}

/**
 * Espera adaptativa pós-ação. Nunca lança. Navegação completa (ou rota de SPA)
 * reaproveita `waitForPageReady` (texto estável) dentro do mesmo teto.
 */
export async function settleAfterAction(
	page,
	{
		urlBefore,
		capMs = SETTLE_CAP_MS,
		quietMs = SETTLE_QUIET_MS,
		now = Date.now,
		sleep,
		ready = waitForPageReady,
	} = {},
) {
	const start = now();
	const remaining = () => Math.max(0, capMs - (now() - start));
	await page.evaluate(installProbeInPage).catch(() => {});
	const loop = await waitUntilSettled({
		probe: async (mark) => {
			try {
				return await page.evaluate(readProbeInPage, mark);
			} catch {
				return null;
			}
		},
		quietMs,
		capMs,
		now,
		sleep,
	});
	let settled = loop.state === "settled";
	const urlNow = () => {
		try {
			return page.url();
		} catch {
			return urlBefore ?? "";
		}
	};
	const routeChanged = urlBefore !== undefined && urlNow() !== urlBefore;
	if (loop.state === "navigated" || routeChanged) {
		try {
			await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(remaining() || 1, 3000)) });
		} catch {
			// Navegação lenta: a prontidão abaixo reporta.
		}
		const state = await ready(page, { capMs: Math.max(1000, READY_CAP_MS - (now() - start)), now, sleep });
		settled = state.ready;
	}
	let url = "";
	let title = "";
	try {
		url = page.url();
		title = await page.title();
	} catch {
		// Página fechou no meio: devolve o que tem.
	}
	return {
		url,
		title,
		navigated: urlBefore !== undefined && url !== urlBefore,
		settled,
		waitMs: now() - start,
	};
}
