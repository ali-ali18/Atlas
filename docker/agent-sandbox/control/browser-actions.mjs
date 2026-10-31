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
/**
 * Roda DENTRO da página (evaluate): vale o campo para o login do Cofre? Autônoma, sem fechamento (o Playwright
 * serializa a função). Devolve "ok" ou o motivo da recusa. `arg` = { kind: "password" | "username", origin }.
 * Usa só métodos do protótipo para ler atributos: a página pode sombrear `form.getAttribute` com um input de nome igual.
 */
export function loginFieldVerdict(el, arg) {
	const kind = arg && arg.kind;
	const origin = arg && arg.origin;
	if (!(el instanceof HTMLInputElement)) return "not-input";
	if (el.ownerDocument !== window.document) return "other-document";
	if (origin && window.location.origin !== origin) return "other-origin";
	const attr = (node, name) => Element.prototype.getAttribute.call(node, name);
	const parentOf = (node) => {
		if (node.parentElement) return node.parentElement;
		const root = node.getRootNode ? node.getRootNode() : null;
		return root && root.host ? root.host : null;
	};

	// Visível de verdade: caixa maior que 1px dentro da página (não jogada para fora da tela), sem display:none,
	// visibility oculta, opacidade 0 em si ou em ancestral, e sem ser cortado por um ancestral com overflow.
	const visible = (node) => {
		const rect = node.getBoundingClientRect();
		if (!(rect.width > 1 && rect.height > 1)) return false;
		if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
		const pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
		if (rect.bottom + window.scrollY <= 0 || rect.top + window.scrollY >= pageHeight) return false;
		const own = getComputedStyle(node);
		if (own.visibility === "hidden" || own.visibility === "collapse") return false;
		for (let n = node; n && n.nodeType === 1; n = parentOf(n)) {
			const style = getComputedStyle(n);
			if (style.display === "none" || n.hidden === true) return false;
			if (!(parseFloat(style.opacity) > 0)) return false;
			if (n !== node && (style.overflow !== "visible" || style.overflowX !== "visible" || style.overflowY !== "visible")) {
				const box = n.getBoundingClientRect();
				const w = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
				const h = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
				if (!(w > 1 && h > 1)) return false;
			}
		}
		return true;
	};

	// O formulário só pode enviar para a própria origem (action e formaction de qualquer botão dele).
	const sameOrigin = (raw) => {
		if (raw === null || raw === undefined) return true;
		const text = String(raw).trim();
		if (!text || /^javascript:/i.test(text)) return true;
		try {
			return new URL(text, document.baseURI).origin === window.location.origin;
		} catch {
			return false;
		}
	};
	const form = el.form;
	if (form) {
		if (!sameOrigin(attr(form, "action"))) return "cross-origin-action";
		for (const control of document.querySelectorAll("[formaction]")) {
			if (control.form === form && !sameOrigin(attr(control, "formaction"))) return "cross-origin-action";
		}
	}

	const type = (attr(el, "type") || "text").toLowerCase();
	if (kind === "password") {
		if (type !== "password") return "not-password";
		return visible(el) ? "ok" : "hidden";
	}
	if (kind === "code") {
		// Código de verificação (e-mail/SMS) que o runtime digita depois do login: campo de código visível, nunca de senha.
		if (type !== "text" && type !== "tel" && type !== "number") return "bad-type";
		if (!visible(el)) return "hidden";
		const named = `${attr(el, "name") || ""} ${attr(el, "id") || ""} ${attr(el, "autocomplete") || ""} ${attr(el, "inputmode") || ""}`;
		return /code|otp|token|verif|pin|codigo|código|one-time|numeric/i.test(named) ? "ok" : "not-code";
	}
	if (type !== "text" && type !== "email" && type !== "tel") return "bad-type";
	if (!visible(el)) return "hidden";
	const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
	if (passwords.length > 0) {
		// Usuário e senha no mesmo formulário (ou os dois soltos, sem <form>).
		return passwords.some((password) => password.form === form) ? "ok" : "other-form";
	}
	// Primeira tela do login em duas telas (ainda sem campo de senha): só campo com cara de usuário.
	const auto = (attr(el, "autocomplete") || "").toLowerCase();
	const named = `${attr(el, "name") || ""} ${attr(el, "id") || ""}`;
	return type === "email" || /(^|\s)(username|email)(\s|$)/.test(auto) || /user|login|email/i.test(named) ? "ok" : "not-username";
}

const LOGIN_FIELD_NAME = { password: "senha", username: "usuário", code: "código" };
const LOGIN_GUARD_WAIT_MS = 3000;
const LOGIN_GUARD_MAX_CANDIDATES = 20;

/** Mensagem do control server quando a página não tem o campo (o runtime trata como "campo ausente", não como recusa). */
export function loginFieldMissingMessage(kind) {
	return `Não achei o campo de ${LOGIN_FIELD_NAME[kind] ?? kind} na página principal; nada foi digitado.`;
}

function loginRefusalMessage(kind, verdict) {
	if (verdict === "other-origin") return "A página mudou de site antes de digitar; nada foi digitado.";
	if (verdict === "cross-origin-action") return "Recusado: o formulário deste campo envia os dados para outro site. Nada foi digitado.";
	if (verdict === "hidden") return "Recusado: o campo está oculto ou fora da tela. Nada foi digitado.";
	if (kind === "code") return "Recusado: o código só pode ser digitado em um campo de código visível da página principal. Nada foi digitado.";
	if (kind === "password") return "Recusado: a senha só pode ser digitada em um campo de senha visível da página principal. Nada foi digitado.";
	return "Recusado: o usuário só pode ser digitado em um campo de texto visível do mesmo formulário da senha (ou, antes de existir o campo de senha, em um campo de usuário ou e-mail). Nada foi digitado.";
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
	/** Quanto esperar o campo do login aparecer (SPA monta depois); sem ele, "campo ausente" rápido. */
	loginGuardWaitMs = LOGIN_GUARD_WAIT_MS,
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

	// Login do Cofre: a senha só entra em input[type=password] visível do documento principal; o usuário só em campo de
	// texto/e-mail/telefone visível do mesmo <form> da senha (ou, na 1ª tela de um login em duas telas, em campo com cara de
	// usuário). O formulário não pode enviar para outra origem. O frame principal é o único alcançado. `origin` é o do
	// site já validado pelo runtime: a conferência roda DENTRO da página, no mesmo evaluate que olha o campo, e o
	// preenchimento usa o MESMO elemento (handle), sem reprocurar pelo seletor (sem janela entre conferir e digitar).
	async function pickLoginField(page, selector, guard) {
		if (guard.origin) {
			let current = "";
			try { current = new URL(page.url()).origin; } catch { current = ""; }
			if (current !== guard.origin) throw new Error(loginRefusalMessage(guard.kind, "other-origin"));
		}
		const locator = page.locator(selector);
		try {
			await locator.first().waitFor({ state: "attached", timeout: loginGuardWaitMs });
		} catch {
			throw new Error(loginFieldMissingMessage(guard.kind));
		}
		let handles = [];
		try {
			handles = (await locator.elementHandles()).slice(0, LOGIN_GUARD_MAX_CANDIDATES);
		} catch {
			handles = [];
		}
		if (handles.length === 0) throw new Error(loginFieldMissingMessage(guard.kind));
		const verdicts = [];
		let chosen = null;
		for (const handle of handles) {
			if (chosen) break;
			let verdict;
			try { verdict = await handle.evaluate(loginFieldVerdict, { kind: guard.kind, origin: guard.origin }); } catch { verdict = "gone"; }
			if (verdict === "ok") chosen = handle;
			else verdicts.push(verdict);
		}
		await Promise.all(handles.filter((handle) => handle !== chosen).map((handle) => handle.dispose().catch(() => undefined)));
		if (chosen) return chosen;
		const reason = verdicts.includes("other-origin") ? "other-origin" : verdicts.find((verdict) => verdict !== "gone") ?? "gone";
		if (reason === "gone") throw new Error(loginFieldMissingMessage(guard.kind));
		throw new Error(loginRefusalMessage(guard.kind, reason));
	}

	async function fillHandle(handle, text) {
		try {
			await handle.fill(String(text ?? ""), { timeout: FILL_TIMEOUT_MS });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (shouldRetryPlaywrightError(message)) throw error;
			throw new Error(explainFillError(message));
		}
	}

	async function browserType({ selector, text, submit, guard }) {
		if (guard && !["password", "username", "code"].includes(guard.kind)) throw new Error("guard inválido");
		if (guard && (typeof selector !== "string" || !selector.trim())) throw new Error("O login do Cofre exige um seletor de campo; nada foi digitado.");
		const plan = planTypeTarget({ selector });
		return withPageRetry(async (page) => {
			const handle = guard ? await pickLoginField(page, plan.selector, guard) : null;
			try {
				const urlBefore = page.url();
				let pointer;
				const observed = await observe(
					page,
					async () => {
						if (handle) {
							pointer = await safePointer(() => handle);
							await fillHandle(handle, text);
							// Antes de enviar, reconfere a origem da aba: se navegou durante o preenchimento, não aperta Enter.
							if (submit) {
								let current = "";
								try { current = new URL(page.url()).origin; } catch { current = ""; }
								if (guard.origin && current !== guard.origin) throw new Error("A página mudou de site antes de enviar; o formulário não foi enviado.");
								await page.keyboard.press("Enter");
							}
							return;
						}
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
			} finally {
				if (handle) await handle.dispose().catch(() => undefined);
			}
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
