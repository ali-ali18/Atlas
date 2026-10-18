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
		const owned = new Set(tabs.values());
		page = context.pages().find((candidate) => !candidate.isClosed() && !owned.has(candidate)) ?? await context.newPage();
		return page;
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
