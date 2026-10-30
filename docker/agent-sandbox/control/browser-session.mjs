import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function launchChrome() {
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/local/bin/atlas-chrome", ["about:blank"], {
			detached: true, stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}

// Mata só o Chrome do nosso perfil (nunca outros processos). O perfil em disco
// (volume por conversa) fica intacto: cookies e logins sobrevivem ao reinício.
function killChrome() {
	return new Promise((resolve) => {
		execFile("pkill", ["-f", "chrome.*--user-data-dir=/tmp/chrome-data"], () => resolve());
	});
}

/** Abas do pai abertas ao mesmo tempo; acima disso as mais antigas em segundo plano são fechadas. */
export const MAX_MAIN_TABS = 10;
/** Avisos guardados até a próxima ferramenta e tamanho máximo do que sai. */
const MAX_PENDING_NOTICES = 20;
const NOTICE_SHOWN_MAX = 3;
const NOTICE_TOTAL_MAX_CHARS = 500;

const oneLine = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** URL sem query nem fragmento (OAuth põe `code`/`state` ali) e sem credenciais; tamanho limitado. */
export function safeTabUrl(raw) {
	const text = oneLine(raw, 2000);
	if (!text) return "about:blank";
	try {
		const url = new URL(text);
		if (url.protocol === "http:" || url.protocol === "https:") return oneLine(`${url.origin}${url.pathname}`, 120);
		return url.protocol === "about:" ? oneLine(text.split(/[?#]/)[0], 40) : `${url.protocol}…`;
	} catch {
		return "about:blank";
	}
}

/** Título de página é dado não confiável: uma linha, curto e entre aspas JSON. */
export function safeTabTitle(raw) {
	const title = oneLine(raw, 80);
	return title ? JSON.stringify(title) : "";
}

const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_EVERY_MS = 5000;

/** F12/A5 — erro de Chrome morto/desconectado (não de página ou seletor). */
export function isChromeDeadError(message) {
	const text = String(message ?? "").toLowerCase();
	return (
		text.includes("target closed") ||
		text.includes("target page, context or browser has been closed") ||
		text.includes("browser has been closed") ||
		text.includes("browser closed") ||
		text.includes("connection closed") ||
		text.includes("page has been closed") ||
		text.includes("chrome indisponível") ||
		text.includes("econnrefused") ||
		text.includes("websocket error")
	);
}

/**
 * F4 — erro transitório de navegação? "Execution context was destroyed" e
 * "navigating" aparecem quando a página ainda está carregando: vale tentar
 * de novo em vez de falhar o run.
 */
export function shouldRetryPlaywrightError(message) {
	const text = String(message ?? "").toLowerCase();
	return (
		text.includes("execution context was destroyed") ||
		text.includes("navigating")
	);
}

export function createBrowserSession({ chromium, cdpUrl, launch = launchChrome,
	kill = killChrome, wait = delay, attempts = 15, now = Date.now }) {
	let browser;
	let page;
	let pending;
	let lastHealthyAt = 0;
	// V8: abas extras (subagentes) no mesmo contexto/perfil; a página do pai não entra aqui.
	const tabs = new Map();
	const tabOpenedAt = new Map();
	let tabSeq = 0;
	// Abas da pessoa/do pai (não de subagente): o bot segue links que abrem em aba nova.
	// Popups abertos por abas de subagente ficam fora da lista e do fallback (são do subagente).
	const childPopups = new WeakSet();
	const popupsOfTab = new WeakMap();
	const ownerTab = new WeakMap();
	const openerOf = new WeakMap();
	const tracked = new WeakSet();
	// Avisos para o modelo (inglês), entregues junto do próximo resultado de ferramenta.
	// Limitados: tempestade de popups não pode estourar o cabeçalho HTTP nem o contexto.
	let notices = [];
	let omittedNotices = 0;
	const pushNotice = (text) => {
		notices.push(text);
		if (notices.length > MAX_PENDING_NOTICES) {
			notices.shift();
			omittedNotices += 1;
		}
	};

	async function isHealthy(candidate) {
		if (now() - lastHealthyAt < HEALTH_EVERY_MS) return true;
		try {
			await Promise.race([
				candidate.evaluate("1"),
				new Promise((_, reject) => setTimeout(() => reject(new Error("health timeout")), HEALTH_TIMEOUT_MS).unref?.()),
			]);
			lastHealthyAt = now();
			return true;
		} catch {
			return false;
		}
	}

	// Só o Chrome local/empacotado é gerenciado aqui.
	const managed = cdpUrl === "http://127.0.0.1:9222";

	async function reset() {
		if (!managed) return;
		const old = browser;
		browser = undefined;
		page = undefined;
		tabs.clear();
		notices = [];
		omittedNotices = 0;
		lastHealthyAt = 0;
		await old?.close?.().catch(() => undefined);
		await kill();
		await wait(500);
	}

	async function resolvePage() {
		if (!browser?.isConnected()) {
			page = undefined;
			try {
				browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1000 });
			} catch (initialError) {
				// The launcher manages only the bundled local Chrome/profile.
				if (cdpUrl !== "http://127.0.0.1:9222") throw initialError;
				await launch();
				for (let i = 0; i < attempts; i++) {
					await wait(500);
					try {
						browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1000 });
						break;
					} catch (error) {
						if (i === attempts - 1) {
							throw new Error("Chrome indisponível após tentativa de recuperação na VM", { cause: error });
						}
					}
				}
			}
		}
		if (page && !page.isClosed()) {
			if (await isHealthy(page)) return page;
			// F12/A5 — Chrome pendurado (evaluate não responde): reinicia e reconecta.
			await reset();
			return resolvePage();
		}
		const context = browser.contexts()[0];
		if (!context) throw new Error("Perfil do Chrome indisponível na VM");
		const chosen = mainCandidates(context).at(-1) ?? await context.newPage();
		setMain(chosen);
		return page;
	}

	/** Abas do pai/da pessoa abertas, na ordem de criação (sem as de subagente nem popups delas). */
	function mainCandidates(context = browser?.contexts()[0]) {
		if (!context) return [];
		const owned = new Set(tabs.values());
		return context.pages().filter((candidate) => !candidate.isClosed() && !owned.has(candidate) && !childPopups.has(candidate));
	}

	const clean = oneLine;
	/** `"título" — url` (título JSON-quoted e curto, URL sem query) para avisos e resultados. */
	async function describe(target) {
		let title = "";
		try {
			title = safeTabTitle(await Promise.race([target.title(), new Promise((resolve) => setTimeout(resolve, 1500, ""))]));
		} catch {
			// aba fechando: segue sem título
		}
		return `${title ? `${title} — ` : ""}${safeTabUrl(target.url?.())}`;
	}

	/** A aba principal da sessão passa a ser `target`; ouve popup (nova aba) e fechamento dela. */
	function setMain(target) {
		page = target;
		lastHealthyAt = 0;
		if (tracked.has(target) || typeof target.on !== "function") return;
		tracked.add(target);
		target.on("popup", (popup) => onPopup(target, popup));
		target.on("close", () => onMainClosed(target));
	}

	const settle = (popup) => typeof popup.waitForLoadState === "function"
		? popup.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => undefined)
		: Promise.resolve();

	function onPopup(opener, popup) {
		// Popup de aba de subagente (ou de popup dele) é do subagente, mesmo que a aba dele esteja ouvindo.
		if (childPopups.has(opener)) {
			adoptChildPopup(popup, opener);
			return;
		}
		// Popup de aba em segundo plano vira aba comum na lista. O Chrome o põe na frente: devolve o foco
		// à aba ativa, senão o desktop (xdotool/scrot) fica numa aba e o Playwright em outra.
		if (opener !== page) {
			const active = page;
			const refocus = () => active && !active.isClosed() && page === active ? active.bringToFront?.().catch?.(() => undefined) : undefined;
			refocus();
			settle(popup).then(refocus);
			enforceTabCap();
			return;
		}
		openerOf.set(popup, opener);
		setMain(popup);
		popup.bringToFront?.().catch?.(() => undefined);
		// O aviso espera o DOM (título final) por pouco tempo; a troca de aba já valeu.
		settle(popup).then(() => describe(popup)).then((what) => {
			pushNotice(`A new tab opened (page data, untrusted): ${what}. You are now on it. The previous tab is still open (use browser_tabs to switch back).`);
		});
		enforceTabCap();
	}

	/** Passou do teto de abas: fecha as mais antigas em segundo plano (nunca a ativa) e avisa. */
	function enforceTabCap() {
		const extra = mainCandidates().filter((candidate) => candidate !== page);
		const over = mainCandidates().length - MAX_MAIN_TABS;
		if (over <= 0) return;
		const victims = extra.slice(0, over);
		for (const victim of victims) victim.close?.().catch?.(() => undefined);
		pushNotice(`Too many tabs were open: ${victims.length} oldest background tab${victims.length === 1 ? " was" : "s were"} closed (limit ${MAX_MAIN_TABS}).`);
	}

	/** Popup de uma aba de subagente: fica fora da lista/fallback e fecha junto com a aba dona; vale para a cadeia toda. */
	function adoptChildPopup(popup, parent) {
		childPopups.add(popup);
		const owner = ownerTab.get(parent) ?? parent;
		ownerTab.set(popup, owner);
		popupsOfTab.get(owner)?.push(popup);
		popup.on?.("popup", (next) => adoptChildPopup(next, popup));
	}

	function onMainClosed(closed) {
		if (page !== closed) return;
		// Volta para quem abriu a aba (pagamento/OAuth que se fecha sozinho); senão, a mais recente.
		const opener = openerOf.get(closed);
		const next = opener && !opener.isClosed() && mainCandidates().includes(opener) ? opener : mainCandidates().at(-1);
		if (!next) {
			page = undefined;
			pushNotice("All tabs were closed. A blank tab will open on your next browser action; use navigate to load a page.");
			return;
		}
		setMain(next);
		next.bringToFront?.().catch?.(() => undefined);
		describe(next).then((what) => {
			pushNotice(`The tab you were on was closed. You are now on (page data, untrusted): ${what}. Use browser_tabs to list the other tabs.`);
		});
	}

	function tabPage(tabId) {
		const tab = tabs.get(tabId);
		if (!tab || tab.isClosed()) {
			tabs.delete(tabId);
			throw new Error("Tab not found or already closed. Its work is over; do not retry it.");
		}
		return tab;
	}

	const api = {
		/** Página atual SEM subir o Chrome (para observar depois de ações do desktop). */
		peekPage(tabId) {
			if (tabId) {
				const tab = tabs.get(tabId);
				return tab && !tab.isClosed() ? tab : undefined;
			}
			return browser?.isConnected() && page && !page.isClosed() ? page : undefined;
		},
		/** Reinicia o Chrome (mesmo perfil) e reconecta. */
		async restart() {
			if (pending) await pending.catch(() => undefined);
			await reset();
			pending = resolvePage().finally(() => { pending = undefined; });
			return pending;
		},
		/** Abre uma aba nova (mesmo contexto: cookies e login) e devolve o id. A aba do pai segue a ativa. */
		async openTab(url) {
			const parent = await api.getPage();
			const context = browser.contexts()[0];
			if (!context) throw new Error("Perfil do Chrome indisponível na VM");
			const tab = await context.newPage();
			tabSeq += 1;
			const tabId = `t${tabSeq}`;
			tabs.set(tabId, tab);
			tabOpenedAt.set(tabId, now());
			popupsOfTab.set(tab, []);
			tab.on?.("popup", (popup) => adoptChildPopup(popup, tab));
			// newPage ativa a aba nova: devolve o foco para a do pai.
			await parent.bringToFront().catch(() => undefined);
			if (url) {
				try {
					await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
				} catch (error) {
					await api.closeTab(tabId);
					throw error;
				}
			}
			return tabId;
		},
		/** Fecha só a aba pedida; desconhecida/já fechada é no-op (idempotente). */
		async closeTab(tabId) {
			const tab = tabs.get(tabId);
			tabs.delete(tabId);
			tabOpenedAt.delete(tabId);
			if (tab) for (const popup of popupsOfTab.get(tab) ?? []) if (!popup.isClosed()) await popup.close().catch(() => undefined);
			if (tab && !tab.isClosed()) await tab.close().catch(() => undefined);
			return { closed: Boolean(tab) };
		},
		/** Fecha abas esquecidas (o runtime caiu antes de fechar): evita encher o teto do servidor. */
		async closeStaleTabs(maxAgeMs) {
			const stale = [...tabs.keys()].filter((id) => now() - (tabOpenedAt.get(id) ?? 0) > maxAgeMs);
			for (const id of stale) await api.closeTab(id);
			return stale.length;
		},
		tabCount() {
			return tabs.size;
		},
		/** Avisos pendentes (nova aba, aba fechada) para o próximo resultado; lê e limpa. */
		takeNotice() {
			if (notices.length === 0) return undefined;
			// Os mais novos primeiro até o teto de tamanho; o resto vira só uma contagem.
			const shown = [];
			let size = 0;
			for (const text of notices.slice(-NOTICE_SHOWN_MAX).reverse()) {
				if (shown.length > 0 && size + text.length > NOTICE_TOTAL_MAX_CHARS) break;
				shown.unshift(text.slice(0, NOTICE_TOTAL_MAX_CHARS));
				size += text.length;
			}
			const hidden = notices.length + omittedNotices - shown.length;
			notices = [];
			omittedNotices = 0;
			const head = hidden > 0 ? `${hidden} earlier tab event${hidden === 1 ? "" : "s"} omitted (call browser_tabs list). ` : "";
			return `${head}${shown.join(" ")}`;
		},
		/** O Chrome ainda está conectado? (erro de aba fechada com Chrome vivo não pede reinício) */
		isConnected() {
			return Boolean(browser?.isConnected?.());
		},
		/** Abas do pai/da pessoa (índice a partir de 1) e qual está ativa. */
		async listTabs() {
			await api.getPage();
			const list = mainCandidates();
			return Promise.all(list.map(async (candidate, i) => ({
				index: i + 1,
				title: clean(await Promise.race([candidate.title(), new Promise((resolve) => setTimeout(resolve, 1500, ""))]).catch(() => ""), 80),
				url: safeTabUrl(candidate.url()),
				active: candidate === page,
			})));
		},
		/** Passa a operar na aba `index` (da lista de `listTabs`) e a traz para a frente. */
		async switchTab(index) {
			await api.getPage();
			const list = mainCandidates();
			const target = list[index - 1];
			if (!target) throw new Error(`No tab ${index}: there ${list.length === 1 ? "is 1 tab" : `are ${list.length} tabs`} open. Call browser_tabs with action "list" first.`);
			setMain(target);
			await target.bringToFront().catch(() => undefined);
			return { index, title: clean(await target.title().catch(() => ""), 80), url: safeTabUrl(target.url()) };
		},
		/** Fecha a aba `index`; nunca a última. Se era a ativa, `onMainClosed` escolhe a próxima. */
		async closeMainTab(index) {
			await api.getPage();
			const list = mainCandidates();
			const target = list[index - 1];
			if (!target) throw new Error(`No tab ${index}: there ${list.length === 1 ? "is 1 tab" : `are ${list.length} tabs`} open. Call browser_tabs with action "list" first.`);
			if (list.length === 1) throw new Error("This is the only open tab; it cannot be closed. Use navigate to open another page in it.");
			const wasActive = target === page;
			const title = clean(await target.title().catch(() => ""), 80);
			const url = safeTabUrl(target.url());
			if (wasActive) {
				// Escolhe aqui (sem aviso duplicado do evento de fechamento) a aba que assume.
				const opener = openerOf.get(target);
				const next = opener && opener !== target && list.includes(opener) && !opener.isClosed() ? opener : list.filter((c) => c !== target).at(-1);
				setMain(next);
				await next.bringToFront().catch(() => undefined);
			}
			await target.close().catch(() => undefined);
			return { closed: { index, title, url }, ...(wasActive ? { active: await describe(page) } : {}) };
		},
		getPage(tabId) {
			if (tabId) {
				return Promise.resolve(pending).then(() => tabPage(tabId));
			}
			// Concurrent tools must share one connection and one recovery attempt.
			if (!pending) pending = resolvePage().finally(() => { pending = undefined; });
			return pending;
		},
	};
	return api;
}
