import { isChromeDeadError, shouldRetryPlaywrightError } from "./browser-session.mjs";
import { settleAfterAction, waitForPageReady } from "./stability.mjs";
import { INTERACTIVE_SELECTOR, createClickLadder } from "./click-ladder.mjs";
import { safePointer } from "./pointer.mjs";
import {
	explainFillError,
	compactPlaywrightError,
	planClick,
	planClickTarget,
	planTypeTarget,
} from "./target.mjs";

const FILL_TIMEOUT_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ações de browser (Playwright) com o `getPage` injetado — testáveis com
 * uma página falsa. O server HTTP só roteia para cá.
 */
/** Roda DENTRO da página (evaluate): vale o campo? Mantida autônoma, sem fechamento. */
function loginFieldVerdict(el, kind) {
	if (!(el instanceof HTMLInputElement)) return "not-input";
	if (el.ownerDocument !== window.document) return "other-document";
	const type = (el.getAttribute("type") || "text").toLowerCase();
	if (kind === "password") return type === "password" ? "ok" : "not-password";
	if (type !== "text" && type !== "email" && type !== "tel") return "bad-type";
	const password = document.querySelector('input[type="password"]');
	if (password && password.form !== el.form) return "other-form";
	return "ok";
}

export function createBrowserActions({
	getPage,
	restart,
	/** O Chrome segue conectado? Erro de "aba fechada" com Chrome vivo não justifica reiniciar (perderia todas as abas). */
	browserAlive,
	wait = sleep,
	stabilize = settleAfterAction,
	ready = waitForPageReady,
	ladder = createClickLadder(),
	now = Date.now,
}) {
	const { clickElement } = ladder;

	// V4 — observador "o que mudou" (vem do createRefActions, que dono dos refs).
	// Sem ele (testes com página falsa), só a espera adaptativa.
	let observer = null;
	const setObserver = (fn) => {
		observer = fn;
	};
	async function observe(page, run, urlBefore) {
		if (observer) return observer(page, run, { urlBefore });
		const result = await run();
		return { result, effect: await stabilize(page, { urlBefore }) };
	}
	const extras = (observed) => ({
		...(observed.changes ? { changes: observed.changes } : {}),
		...(observed.errors ? { errors: observed.errors } : {}),
		...(observed.newTotal !== undefined ? { newElements: observed.newElements, newTotal: observed.newTotal } : {}),
	});

	// F4 — a página pode estar no meio de uma navegação: espera o DOM e tenta
	// de novo erros transitórios ("Execution context was destroyed"/"navigating").
	async function settle(page) {
		try {
			await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
		} catch {
			// Ainda carregando — segue com o que já tem.
		}
	}

	async function withPageRetry(action, { tries = 3, retryOn } = {}) {
		let lastError;
		let softRetried = false;
		for (let attempt = 1; attempt <= tries; attempt += 1) {
			try {
				const page = await getPage();
				if (attempt === 1) await settle(page);
				return await action(page);
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				if (attempt >= tries) throw error;
				// Popup (OAuth/pagamento) que se fecha no meio da ação: a sessão já passou para outra aba;
				// com o Chrome vivo basta pegar a página de novo, uma vez, sem reiniciar.
				if (isChromeDeadError(message) && !softRetried && browserAlive?.() === true) {
					softRetried = true;
					await wait(200);
					continue;
				}
				if (isChromeDeadError(message) && restart) {
					// F12/A5 — Chrome morto: reinicia (mesmo perfil) e tenta de novo.
					await restart();
					continue;
				}
				if (!shouldRetryPlaywrightError(message) && !retryOn?.(message)) throw error;
				await wait(500);
			}
		}
		throw lastError;
	}

	async function clickByText(page, plan) {
		const locator = plan.scope
			? page.locator(plan.scope).filter({ hasText: plan.text })
			: page.getByText(plan.text, { exact: false });
		const candidates = await locator.evaluateAll((els, selector) => {
			const groups = new Map();
			return els.slice(0, 40).map((el) => {
				const rect = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				const ancestor = el.closest(selector);
				if (ancestor && !groups.has(ancestor)) groups.set(ancestor, `g${groups.size}`);
				return {
					text: el.innerText || el.textContent || el.value || "",
					visible:
						rect.width > 0 && rect.height > 0 &&
						style.visibility !== "hidden" && style.display !== "none",
					interactive: Boolean(ancestor),
					...(ancestor ? { group: groups.get(ancestor) } : {}),
				};
			});
		}, INTERACTIVE_SELECTOR);
		const pick = planClick(candidates, plan.text);
		if (!pick) {
			throw new Error(
				`Nenhum elemento visível com o texto "${plan.text}"${plan.scope ? ` dentro de "${plan.scope}"` : ""}. Use browser_snapshot para ver os elementos da página.`,
			);
		}
		const click = await clickElement(page, locator.nth(pick.index), { label: plan.text });
		return { ...click, target: plan.text, matches: pick.matches, ambiguous: pick.ambiguous };
	}

	// Só `Execution context was destroyed` repete (withPageRetry); o resto
	// falha rápido com erro compacto em vez de repetir 15 s de timeout.
	async function browserClick({ selector, text }) {
		const plan = planClickTarget({ selector, text });
		return withPageRetry(async (page) => {
			const urlBefore = page.url();
			const observed = await observe(
				page,
				async () =>
					plan.mode === "selector"
						? {
							...(await clickElement(page, page.locator(plan.selector).first(), { label: plan.selector })),
							target: plan.selector,
						}
						: await clickByText(page, plan),
				urlBefore,
			);
			return { ...observed.result, ...observed.effect, ...extras(observed) };
		}, { tries: 2 });
	}

	// Login do Cofre: a senha só entra em input[type=password] do documento principal; o usuário só em input de
	// texto/e-mail/telefone do mesmo <form> do campo de senha. O frame principal é o único alcançado (page.locator
	// e page.fill nunca entram em iframe). `origin` é o do site já validado pelo runtime: se a aba mudou de origem
	// entre a validação e a digitação, aborta sem digitar.
	async function guardLoginField(page, selector, guard) {
		if (guard.origin) {
			let current = "";
			try { current = new URL(page.url()).origin; } catch { current = ""; }
			if (current !== guard.origin) throw new Error("A página mudou de site antes de digitar; nada foi digitado.");
		}
		let verdict;
		try {
			verdict = await page.locator(selector).first().evaluate(loginFieldVerdict, guard.kind);
		} catch {
			throw new Error("Não achei o campo na página principal; nada foi digitado.");
		}
		if (verdict === "ok") return;
		throw new Error(
			guard.kind === "password"
				? "Recusado: a senha só pode ser digitada em um campo de senha da página principal. Nada foi digitado."
				: "Recusado: o usuário só pode ser digitado em um campo de texto do mesmo formulário da senha. Nada foi digitado.",
		);
	}

	async function browserType({ selector, text, submit, guard }) {
		if (guard && (guard.kind !== "password" && guard.kind !== "username")) throw new Error("guard inválido");
		if (guard && (typeof selector !== "string" || !selector.trim())) throw new Error("O login do Cofre exige um seletor de campo; nada foi digitado.");
		const plan = planTypeTarget({ selector });
		return withPageRetry(async (page) => {
			if (guard) await guardLoginField(page, plan.selector, guard);
			const urlBefore = page.url();
			let pointer;
			const observed = await observe(
				page,
				async () => {
					if (plan.mode === "selector") {
						pointer = await safePointer(() => page.locator(plan.selector).first());
						try {
							await page.fill(plan.selector, String(text ?? ""), { timeout: FILL_TIMEOUT_MS });
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							if (shouldRetryPlaywrightError(message)) throw error;
							throw new Error(explainFillError(message));
						}
					} else {
						await page.keyboard.type(String(text ?? ""));
					}
					if (submit) await page.keyboard.press("Enter");
				},
				urlBefore,
			);
			return { ok: true, ...(pointer ? { pointer } : {}), ...observed.effect, ...extras(observed) };
		}, { tries: 2 });
	}

	// net::ERR_ABORTED: outra navegação interrompeu a nossa (redirect/download).
	const isAbortedNavigation = (message) => /ERR_ABORTED|frame was detached/i.test(message);

	async function navigate(url) {
		return withPageRetry(async (page) => {
			const t0 = now();
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			const gotoMs = now() - t0;
			// V1: espera o CONTEÚDO (SPA monta o texto depois do load), não a rede.
			const state = await ready(page);
			return {
				url: state.url || page.url(),
				title: state.title,
				settled: state.ready,
				ready: state.ready,
				gotoMs,
				readyMs: state.readyMs,
				textLength: state.textLength,
				...(state.ready ? {} : { hint: "page is still rendering; call browser_wait or read again" }),
			};
		}, { tries: 3, retryOn: isAbortedNavigation });
	}

	return { withPageRetry, settle, browserClick, browserType, navigate, clickElement, setObserver };
}
