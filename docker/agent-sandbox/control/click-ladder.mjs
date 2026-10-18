// V1 — clique que funciona: resolve o elemento INTERATIVO (não o nó de texto),
// descobre quem cobre o alvo antes de clicar e escala por degraus com timeout
// curto em vez de esperar 15 s por "intercepts pointer events".
import { CONSENT_CONFIG, dismissConsentInPage } from "./consent.mjs";
import { shouldRetryPlaywrightError } from "./browser-session.mjs";
import { safePointer } from "./pointer.mjs";

export const INTERACTIVE_SELECTOR =
	'a[href], button, input[type="button"], input[type="submit"], summary, [onclick], ' +
	'[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
	'[role="menuitemradio"], [role="option"], [role="checkbox"], [role="switch"], ' +
	'[tabindex]:not([tabindex^="-"])';

/** Timeouts por degrau (ms): o pior caso fica abaixo de ~10 s, não 15 s x tries. */
export const LADDER_TIMEOUTS = { click: 2500, retry: 1500, overlay: 2000, banner: 1500, mouse: 1500 };

export const MARK_ATTR = "data-atlas-click";

/**
 * Roda NA página (autossuficiente). Sobe ao ancestral interativo (se
 * `cfg.retarget`), marca o alvo com `data-atlas-click=target` e mede quem
 * está por cima do centro dele (`elementFromPoint`). Marca a capa como `cover`.
 */
export function inspectInPage(el, cfg) {
	const attr = cfg.markAttr;
	let target = el;
	if (cfg.retarget) {
		for (const old of document.querySelectorAll(`[${attr}]`)) old.removeAttribute(attr);
		target = el.closest(cfg.interactive) ?? el;
		target.setAttribute(attr, "target");
	} else {
		target = document.querySelector(`[${attr}="target"]`) ?? el;
		for (const old of document.querySelectorAll(`[${attr}="cover"]`)) old.removeAttribute(attr);
	}
	if (cfg.scroll) {
		try {
			target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		} catch {
			// Sem scroll possível: mede onde está.
		}
	}
	const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
	const nameOf = (n) =>
		clean(n.getAttribute("aria-label")) || clean(n.innerText || n.textContent) || clean(n.getAttribute("title"));
	const describe = (n) => ({
		tag: n.tagName.toLowerCase(),
		role: n.getAttribute("role") || undefined,
		name: nameOf(n).slice(0, 40) || undefined,
	});
	const visibleBox = (n) => {
		const r = n.getBoundingClientRect();
		const s = getComputedStyle(n);
		return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
	};
	const rect = target.getBoundingClientRect();
	const visible = visibleBox(target);
	const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
	const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);

	let top = document.elementFromPoint(cx, cy);
	while (top && top.shadowRoot) {
		const inner = top.shadowRoot.elementFromPoint(cx, cy);
		if (!inner || inner === top) break;
		top = inner;
	}
	const covered = Boolean(visible && top && top !== target && !target.contains(top));
	let cover;
	if (covered) {
		const ci = top.closest(cfg.interactive);
		const cb = ci ? ci.getBoundingClientRect() : null;
		const tolerance = 2;
		const containsTarget = Boolean(
			cb &&
				cb.left <= rect.left + tolerance && cb.top <= rect.top + tolerance &&
				cb.right >= rect.right - tolerance && cb.bottom >= rect.bottom - tolerance,
		);
		const targetLink = target.closest("a[href]") ?? target.querySelector("a[href]");
		const sameDest = Boolean(ci && ci.tagName === "A" && targetLink && ci.href === targetLink.href);
		const containerRx = new RegExp(cfg.container, "iu");
		let consent = false;
		for (let n = top; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
			const role = n.getAttribute("role");
			const pos = getComputedStyle(n).position;
			const structural =
				pos === "fixed" || pos === "sticky" ||
				["dialog", "alertdialog", "region", "complementary", "banner"].includes(role) ||
				n.getAttribute("aria-modal") === "true";
			if (!structural) continue;
			const hint = `${n.id} ${typeof n.className === "string" ? n.className : ""} ${n.getAttribute("aria-label") ?? ""}`;
			if (containerRx.test(hint) || /cookie/i.test(clean(n.innerText).slice(0, 800))) {
				consent = true;
				break;
			}
		}
		const coverEl = ci ?? top;
		coverEl.setAttribute(attr, "cover");
		cover = { ...describe(coverEl), interactive: Boolean(ci), containsTarget, sameDest, consent };
	}
	const modal = [...document.querySelectorAll('[aria-modal="true"]')].find(visibleBox);
	return {
		visible,
		interactive: target.matches(cfg.interactive),
		retargeted: target !== el ? describe(target) : undefined,
		target: describe(target),
		cx,
		cy,
		covered,
		cover,
		blockedByModal: Boolean(modal && !modal.contains(target)),
	};
}

const firstLine = (error) => String(error instanceof Error ? error.message : error).split("\n")[0].slice(0, 80);

/** "<tag role=x "name">" curto de um elemento descrito pela página. */
export function describeBlocker(cover) {
	if (!cover) return "";
	const role = cover.role ? ` role=${cover.role}` : "";
	const name = cover.name ? ` "${cover.name}"` : "";
	return `<${cover.tag}${role}${name}>`;
}

export const CLICK_ERROR_MAX = 300;

/**
 * Erro compacto (<= 300 chars) para o modelo: o que bloqueou, o que foi tentado
 * e o próximo passo. Nunca inclui o call log do Playwright.
 */
export function formatClickError({ label, info, tried, lastError }) {
	const shownLabel = String(label ?? "element").replace(/\s+/g, " ").slice(0, 40);
	let reason;
	if (info?.blockedByModal) reason = "a modal dialog that does not contain it is open";
	else if (info?.covered) reason = `covered by another element ${describeBlocker(info.cover)}`;
	else if (info && !info.visible) reason = "the element is not visible";
	else reason = lastError ? firstLine(lastError) : "the click had no effect";
	const text = `Click on "${shownLabel}" failed: ${reason}. Tried: ${tried.join(", ") || "none"}. Use browser_snapshot, then browser_act on a ref, or close what covers it.`;
	return text.length <= CLICK_ERROR_MAX ? text : `${text.slice(0, CLICK_ERROR_MAX - 1)}…`;
}

/**
 * Escada de cliques sobre um locator (já apontando para o nó achado).
 * `consentSeen` guarda (por página) em que URLs o banner já foi tratado.
 */
export function createClickLadder({ timeouts = LADDER_TIMEOUTS, now = Date.now } = {}) {
	const consentSeen = new WeakMap();

	const keyOf = (page) => {
		try {
			const url = new URL(page.url());
			return `${url.origin}${url.pathname}`;
		} catch {
			return String(page.url?.() ?? "");
		}
	};

	/** Uma vez por página: recusa/fecha o banner. Devolve true se agiu. */
	async function dismissConsentOnce(page) {
		const key = keyOf(page);
		const seen = consentSeen.get(page) ?? new Set();
		if (seen.has(key)) return false;
		seen.add(key);
		consentSeen.set(page, seen);
		try {
			const outcome = await page.evaluate(dismissConsentInPage, CONSENT_CONFIG);
			return Boolean(outcome?.dismissed);
		} catch {
			return false;
		}
	}

	async function clickElement(page, locator, { label = "element" } = {}) {
		const started = now();
		const tried = [];
		let lastError;
		const base = { markAttr: MARK_ATTR, interactive: INTERACTIVE_SELECTOR, container: CONSENT_CONFIG.container };
		const target = locator.locator(`xpath=ancestor-or-self::*[@${MARK_ATTR}="target"]`);
		const inspect = (extra) => locator.evaluate(inspectInPage, { ...base, ...extra });

		let info = await inspect({ retarget: true, scroll: true });
		const pointer = await safePointer(() => target);
		const finish = (rung, extra = {}) => ({
			ok: true,
			rung,
			tried: [...tried],
			clickMs: now() - started,
			...(info.retargeted ? { retargeted: describeBlocker(info.retargeted) } : {}),
			...(pointer ? { pointer } : {}),
			...extra,
		});
		// Um clique que navega pode derrubar o contexto no meio: conta como feito.
		const attempt = async (name, run) => {
			tried.push(name);
			try {
				await run();
				return true;
			} catch (error) {
				if (shouldRetryPlaywrightError(error instanceof Error ? error.message : String(error))) return true;
				lastError = error;
				return false;
			}
		};
		const refresh = async (scroll) => {
			try {
				info = await inspect({ retarget: false, scroll });
			} catch {
				// Elemento sumiu: mantém o último diagnóstico.
			}
		};

		// 1. clique normal (só se nada cobre o centro: evita esperar o timeout).
		if (!info.covered && (await attempt("click", () => target.click({ timeout: timeouts.click })))) {
			return finish("click");
		}
		// 2. rolar até o centro e tentar de novo.
		if (!info.covered) {
			await refresh(true);
			if (!info.covered && (await attempt("scroll", () => target.click({ timeout: timeouts.retry })))) {
				return finish("scroll");
			}
		}
		// 3. banner de consentimento: só recusar/fechar, uma vez por página.
		let dismissed;
		if (info.covered && info.cover?.consent) {
			tried.push("banner");
			if (await dismissConsentOnce(page)) {
				dismissed = "consent";
				await refresh(true);
				if (!info.covered && (await attempt("click", () => target.click({ timeout: timeouts.banner })))) {
					return finish("banner", { dismissed });
				}
			}
		}
		const carry = dismissed ? { dismissed } : {};
		// 4. link/botão esticado por cima (card): é o destino real do alvo.
		if (info.covered && info.cover?.interactive && (info.cover.containsTarget || info.cover.sameDest) && !info.cover.consent) {
			const clicked = await attempt("overlay", async () => {
				const cover = page.locator(`[${MARK_ATTR}="cover"]`);
				if ((await cover.count()) > 0) {
					await cover.first().click({ timeout: timeouts.overlay });
				} else {
					await locator.evaluate((_, attr) => document.querySelector(`[${attr}="cover"]`)?.click(), MARK_ATTR);
				}
			});
			if (clicked) return finish("overlay", carry);
		}
		// 5. teclado: foco + Enter (só em elemento interativo, sem modal alheio).
		if (info.interactive && !info.blockedByModal) {
			const pressed = await attempt("keyboard", async () => {
				await target.focus({ timeout: timeouts.mouse });
				const focused = await target.evaluate((el) => document.activeElement === el);
				if (!focused) throw new Error("focus did not move to the element");
				await page.keyboard.press("Enter");
			});
			if (pressed) return finish("keyboard", carry);
		}
		// 6. element.click() via JS: só visível, com caixa e sem modal alheio.
		if (info.visible && !info.blockedByModal) {
			if (await attempt("js", () => target.evaluate((el) => el.click()))) return finish("js", carry);
		}
		// 7. clique por coordenadas do centro. Nunca por cima de modal alheio nem
		// de banner de consentimento: o ponto poderia cair no botão de aceitar.
		if (info.visible && !info.blockedByModal && !(info.covered && info.cover?.consent)) {
			await refresh(true);
			if (await attempt("coords", () => page.mouse.click(info.cx, info.cy))) return finish("coords", carry);
		}
		throw new Error(formatClickError({ label, info, tried, lastError }));
	}

	return { clickElement, dismissConsentOnce };
}
