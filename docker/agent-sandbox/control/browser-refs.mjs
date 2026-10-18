// F12/B1-B3 — snapshot com referências, ação por ref e espera. O Playwright
// entra por `withPageRetry` (injetado), então tudo roda com uma página falsa
// nos testes.
import { explainFillError } from "./target.mjs";
import { installProbeInPage, settleAfterAction } from "./stability.mjs";
import { diffPageDigest, readDigest, summarizeChanges } from "./page-digest.mjs";
import { safePointer } from "./pointer.mjs";
import { createFrameRegistry, frameTag, splitRef } from "./frames.mjs";
import { collectInteractive } from "./snapshot-page.mjs";
import { SNAPSHOT_MAX_SCAN, buildSnapshot, describeElement, formatElementLine } from "./snapshot.mjs";

export const ACT_ACTIONS = ["click", "type", "select", "check", "uncheck", "hover", "press", "clear"];
export const WAIT_KINDS = ["text", "ref", "url", "network", "stable"];
const MAX_TYPE_LENGTH = 20_000;
const MAX_VALUE_LENGTH = 300;
const REF_PATTERN = /^(?:f\d{1,3})?e\d{1,5}$/;
const ACT_TIMEOUT_MS = 10_000;
const MAX_DELTA = 12;
export const WAIT_DEFAULT_MS = 8000;
export const WAIT_MAX_MS = 20_000;
const STALE_HINT = "Tire um novo browser_snapshot e use o ref novo.";

/** Valida e normaliza o corpo de `/browser/act`. Lança com mensagem acionável. */
export function parseActArgs(body) {
	const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
	if (!REF_PATTERN.test(ref)) {
		throw new Error(`ref inválido "${ref}": use um ref do browser_snapshot (ex.: e12).`);
	}
	const action = body?.action;
	if (!ACT_ACTIONS.includes(action)) {
		throw new Error(`action inválida "${action}": use ${ACT_ACTIONS.join(", ")}.`);
	}
	const value = body?.value === undefined || body?.value === null ? undefined : String(body.value);
	if (action === "type") {
		if (value === undefined) throw new Error("type exige `value` (o texto a digitar).");
		if (value.length > MAX_TYPE_LENGTH) throw new Error(`value muito longo (máx. ${MAX_TYPE_LENGTH} caracteres).`);
	}
	if (action === "select") {
		if (!value) throw new Error("select exige `value` (texto ou valor da opção).");
		if (value.length > MAX_VALUE_LENGTH) throw new Error(`value muito longo (máx. ${MAX_VALUE_LENGTH}).`);
	}
	if (action === "press") {
		if (!value) throw new Error("press exige `value` com a tecla (ex.: Enter, Tab, ArrowDown).");
		if (value.length > 40) throw new Error("tecla inválida.");
	}
	return {
		ref,
		action,
		value,
		submit: Boolean(body?.submit),
		sequential: Boolean(body?.sequential),
	};
}

export function parseWaitArgs(body) {
	const kind = body?.for;
	if (!WAIT_KINDS.includes(kind)) {
		throw new Error(`for inválido "${kind}": use ${WAIT_KINDS.join(", ")}.`);
	}
	const value = body?.value === undefined || body?.value === null ? "" : String(body.value);
	if ((kind === "text" || kind === "url") && !value.trim()) throw new Error(`for=${kind} exige \`value\`.`);
	if (kind === "ref" && !REF_PATTERN.test(value.trim())) {
		throw new Error(`for=ref exige um ref do browser_snapshot (ex.: e12).`);
	}
	if (value.length > MAX_VALUE_LENGTH) throw new Error(`value muito longo (máx. ${MAX_VALUE_LENGTH}).`);
	const asked = Number(body?.timeoutMs);
	const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(WAIT_MAX_MS, Math.floor(asked)) : WAIT_DEFAULT_MS;
	return { kind, value: value.trim(), timeoutMs, gone: Boolean(body?.gone) };
}

function refSelector(ref) {
	return `[data-atlas-ref="${ref}"]`;
}

export function createRefActions({
	withPageRetry,
	stabilize = settleAfterAction,
	now = Date.now,
	sleep,
	clickElement,
	registry = createFrameRegistry(),
}) {
	const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

	// Todos os frames (inclusive de outra origem) entram; o ref leva o prefixo do frame.
	const framesOf = (page) => registry.list(page);

	async function collect(page, { scope, mode, area, only, maxScan = SNAPSHOT_MAX_SCAN }) {
		const raws = [];
		let seq = mode === "full" ? 0 : registry.seq;
		for (const entry of framesOf(page)) {
			if (raws.length >= maxScan) break;
			let result;
			try {
				result = await entry.frame.evaluate(collectInteractive, {
					scope: entry.main ? scope : undefined,
					start: seq,
					mode,
					area,
					only,
					prefix: entry.prefix,
					maxScan: maxScan - raws.length,
				});
			} catch {
				continue; // iframe navegando/inacessível: segue com os outros
			}
			seq = result.seq;
			const tag = frameTag(entry);
			for (const item of result.raw) raws.push(tag ? { ...item, inFrame: tag } : item);
		}
		registry.seq = seq;
		return raws;
	}

	async function scrollOf(page) {
		try {
			return await page.evaluate(() => {
				const el = document.scrollingElement || document.documentElement;
				return {
					scrollY: Math.round(el.scrollTop),
					scrollHeight: Math.round(el.scrollHeight),
					viewportHeight: Math.round(window.innerHeight),
				};
			});
		} catch {
			return {};
		}
	}

	async function browserSnapshot({ scope, offset, limit, area } = {}) {
		const selectorScope = typeof scope === "string" && scope.trim() ? scope.trim() : undefined;
		return withPageRetry(async (page) => {
			const raws = await collect(page, {
				scope: selectorScope,
				mode: "full",
				area: area === "page" ? "page" : "viewport",
			});
			return buildSnapshot({
				url: page.url(),
				title: await page.title(),
				raws,
				page: { offset, limit },
				scroll: await scrollOf(page),
			});
		}, { tries: 3 });
	}

	async function locateRef(page, ref) {
		const parsed = splitRef(ref);
		const frame = parsed ? registry.frameOf(page, parsed.prefix) : null;
		if (!frame) return null;
		const locator = frame.locator(refSelector(ref));
		return (await locator.count()) > 0 ? locator.first() : null;
	}

	async function readField(locator) {
		try {
			return await locator.evaluate((el) => {
				if (el.type === "password") return { secret: true };
				const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
				const value = el.tagName === "SELECT" ? el.selectedOptions?.[0]?.textContent : isField ? el.value : el.textContent;
				return {
					value: String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
					checked: typeof el.checked === "boolean" ? el.checked : undefined,
				};
			});
		} catch {
			return undefined; // re-render trocou o elemento: o delta mostra o novo estado
		}
	}

	async function perform(page, locator, args) {
		const { action, value, submit, sequential } = args;
		try {
			switch (action) {
				case "click":
					// V1: escada com timeouts curtos e erro compacto; sem ela (testes), clique simples.
					if (clickElement) return await clickElement(page, locator, { label: args.ref });
					return await locator.click({ timeout: ACT_TIMEOUT_MS });
				case "type":
					if (sequential) {
						await locator.click({ timeout: ACT_TIMEOUT_MS });
						await locator.fill("", { timeout: ACT_TIMEOUT_MS });
						await locator.pressSequentially(value, { delay: 30, timeout: ACT_TIMEOUT_MS });
					} else {
						await locator.fill(value, { timeout: ACT_TIMEOUT_MS });
					}
					if (submit) await locator.press("Enter", { timeout: ACT_TIMEOUT_MS });
					return;
				case "clear":
					return await locator.fill("", { timeout: ACT_TIMEOUT_MS });
				case "select":
					try {
						await locator.selectOption({ label: value }, { timeout: ACT_TIMEOUT_MS });
					} catch {
						await locator.selectOption({ value }, { timeout: ACT_TIMEOUT_MS });
					}
					return;
				case "check":
					return await locator.setChecked(true, { timeout: ACT_TIMEOUT_MS });
				case "uncheck":
					return await locator.setChecked(false, { timeout: ACT_TIMEOUT_MS });
				case "hover":
					return await locator.hover({ timeout: ACT_TIMEOUT_MS });
				case "press":
					return await locator.press(value, { timeout: ACT_TIMEOUT_MS });
				default:
					throw new Error(`action ${action} não suportada`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/not an? <?(input|textarea|select)|not editable/i.test(message)) throw new Error(explainFillError(message));
			if (/did not find some options|option/i.test(message) && action === "select") {
				throw new Error(`Opção "${value}" não existe nesse select. Veja options=[...] no browser_snapshot.`);
			}
			if (/intercepts pointer events|not stable|detached/i.test(message)) {
				throw new Error(`O elemento está coberto ou mudou de lugar (${message.split("\n")[0]}). ${STALE_HINT}`);
			}
			throw error;
		}
	}

	/**
	 * V4 — roda a ação e devolve o que mudou: digest antes/depois (diff puro),
	 * espera adaptativa e refs novos (numerados agora ou que reapareceram).
	 * Nunca falha por causa da observação: sem digest, só o efeito.
	 */
	async function observeAction(page, perform, { urlBefore = page.url() } = {}) {
		await page.evaluate(installProbeInPage).catch(() => {});
		const before = await readDigest(page, registry);
		const result = await perform();
		const effect = await stabilize(page, { urlBefore });
		const after = before ? await readDigest(page, registry) : null;
		const diff = diffPageDigest(before, after);
		const changes = summarizeChanges(diff);
		const reloaded = diff ? diff.reloaded : Boolean(effect.navigated);
		let fresh = [];
		let newTotal = 0;
		if (!reloaded) {
			const raws = await collect(page, { mode: "incremental", area: "viewport", maxScan: MAX_DELTA * 3 });
			fresh = raws.slice(0, MAX_DELTA);
			// Elementos já numerados que voltaram a aparecer (acordeão reaberto).
			const known = new Set(raws.map((item) => item.ref));
			const again = diff ? diff.reappeared.filter((ref) => !known.has(ref)) : [];
			const room = MAX_DELTA - fresh.length;
			if (room > 0 && again.length > 0) {
				fresh = fresh.concat(await collect(page, { mode: "refs", only: again.slice(0, room), maxScan: room }));
			}
			newTotal = raws.length + again.length;
		}
		const elements = fresh.map(describeElement);
		return {
			result,
			effect,
			diff,
			...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
			...(diff && diff.errors.length > 0 ? { errors: diff.errors } : {}),
			newElements: elements.map(formatElementLine),
			newTotal,
		};
	}

	async function browserAct(body) {
		const args = parseActArgs(body);
		return withPageRetry(async (page) => {
			const locator = await locateRef(page, args.ref);
			if (!locator) throw new Error(`Ref ${args.ref} não encontrado: a página mudou ou o ref é de um snapshot antigo. ${STALE_HINT}`);
			try {
				await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
			} catch {
				// Elemento sumiu entre o count e o scroll: a checagem abaixo explica.
			}
			if (!(await locator.isVisible())) {
				throw new Error(`O elemento ${args.ref} não está visível (oculto ou coberto). ${STALE_HINT}`);
			}
			const needsEnabled = args.action !== "hover" && args.action !== "press";
			if (needsEnabled && !(await locator.isEnabled())) {
				throw new Error(`O elemento ${args.ref} está desabilitado. Preencha os campos obrigatórios antes ou escolha outro ref.`);
			}
			const pointer = await safePointer(() => locator);
			const urlBefore = page.url();
			const observed = await observeAction(page, () => perform(page, locator, args), { urlBefore });
			const { effect, result: performed } = observed;
			const readsField = ["type", "clear", "select", "check", "uncheck"].includes(args.action);
			const field = readsField && !effect.navigated ? await readField(locator) : undefined;
			const click = performed && typeof performed === "object" && performed.rung ? performed : undefined;
			return {
				ok: true,
				ref: args.ref,
				action: args.action,
				...(click ? { rung: click.rung, tried: click.tried, ...(click.dismissed ? { dismissed: click.dismissed } : {}) } : {}),
				...(pointer ? { pointer } : {}),
				...effect,
				...(field ? { field } : {}),
				...(observed.errors ? { errors: observed.errors.slice(0, 5) } : {}),
				...(observed.changes ? { changes: observed.changes } : {}),
				newElements: observed.newElements,
				newTotal: observed.newTotal,
			};
		}, { tries: 2 });
	}

	async function waitForRef(page, ref, gone, deadline) {
		for (;;) {
			const locator = await locateRef(page, ref);
			const visible = locator ? await locator.isVisible().catch(() => false) : false;
			if (gone ? !visible : visible) return true;
			if (now() >= deadline) return false;
			await pause(200);
		}
	}

	async function browserWait(body) {
		const { kind, value, timeoutMs, gone } = parseWaitArgs(body);
		return withPageRetry(async (page) => {
			const started = now();
			let met = false;
			let reason = "";
			try {
				if (kind === "text") {
					await page.waitForFunction(
						([text, absent]) => (document.body?.innerText ?? "").includes(text) !== absent,
						[value, gone],
						{ timeout: timeoutMs },
					);
					met = true;
				} else if (kind === "url") {
					await page.waitForURL((url) => url.href.includes(value), { timeout: timeoutMs });
					met = true;
				} else if (kind === "network") {
					await page.waitForLoadState("networkidle", { timeout: timeoutMs });
					met = true;
				} else if (kind === "ref") {
					met = await waitForRef(page, value, gone, started + timeoutMs);
				} else {
					const effect = await stabilize(page, { capMs: timeoutMs });
					met = effect.settled;
				}
			} catch (error) {
				reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
			}
			if (!met && !reason) reason = `não ocorreu em ${timeoutMs} ms`;
			return {
				ok: true,
				met,
				for: kind,
				waitedMs: now() - started,
				url: page.url(),
				title: await page.title().catch(() => ""),
				...(met ? {} : { reason }),
			};
		}, { tries: 2 });
	}

	return { browserSnapshot, browserAct, browserWait, observeAction, collect, locateRef, registry };
}
