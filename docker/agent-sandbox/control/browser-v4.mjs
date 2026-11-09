// F8.1 — despachante das ações `browser.*` do motor v4 (protocolo em packages/agent/src/capabilities/browser/protocol.ts).
// Reaproveita o que já existe: refs e ações (`browser-refs`), abas (`browser-session`), navegação (`browser-actions`). Aqui entram o
// mapa, as partes, a busca, o "carregar mais" e o arquivo (export). Dependências por injeção: roda com página falsa nos testes.
import { judgeAct, probeActTarget, SUBMIT_INTENT_REQUIRED } from "./browser-act-guard.mjs";
import { ITEM_MAX_CHARS, parseReadArgs, planPart } from "./browser-chunks.mjs";
import { atlasInPage } from "./browser-inpage.mjs";
import { CARD_SECRET_SELECTOR } from "./card-fields.mjs";
import { buildMap } from "./browser-map.mjs";
import { FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT, searchItems } from "./browser-search.mjs";

export const MAP_MAX_REFS = 2500;
export const LOAD_MORE_MAX_TIMES = 10;
export const LOAD_SETTLE_MS = 3000;
export const EXPORT_MAX_ROUNDS = 300;
export const EXPORT_MAX_MS = 120_000;
const EXPORT_ITEM_CHARS = 200_000;
const SECTION_RE = /^s\d{1,4}$/;
const REF_RE = /^(?:f\d{1,3})?[ae]\d{1,5}$/;

/** Falha com código estruturado (o servidor o devolve em `code`; o adaptador do worker o põe em `data.code`). */
export class BrowserV4Error extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
}

const sectionArg = (value) => {
	if (typeof value !== "string" || !SECTION_RE.test(value)) throw new Error(`Invalid section "${String(value)}": use an id from browser_map (like "s3").`);
	return value;
};

export function createBrowserV4({ withPageRetry, collect, noteDomRefs = () => {}, browserAct, browserWait, navigate, listTabs, switchTab, closeTab, clickElement, locateRef, resolveAxLocator, workspaceDir, fs, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), newId = () => `x${Math.random().toString(36).slice(2, 10)}` }) {
	// Total declarado e rótulo por seção, da ÚLTIMA leitura do mapa, por página.
	const mapped = new WeakMap();
	const declaredOf = (page, id) => mapped.get(page)?.get(id)?.declaredTotal ?? null;
	const labelOf = (page, id) => mapped.get(page)?.get(id)?.label || id;

	const missing = (id) => new BrowserV4Error(`Section ${id} is no longer on the page (it changed or was never mapped). Hint: call browser_map again.`, "section_missing");
	async function inPage(page, op, arg) {
		const out = await page.evaluate(atlasInPage, { op, arg, cardSelector: CARD_SECRET_SELECTOR });
		if (out?.missing) throw missing(arg.id);
		if (out?.error) throw new Error(out.error);
		return out;
	}

	/** Refs dos controles dentro dos itens marcados (`data-atlas-win=k`): numera um item por vez (o coletor aceita uma raiz). */
	async function refsForWindow(page, id, ns, count) {
		for (let k = 1; k <= count; k += 1) await collect(page, { scope: `[data-atlas-win="${k}"]`, mode: "incremental", area: "page", maxScan: 60 });
		noteDomRefs();
		return (await inPage(page, "refs", { id, ns })).items;
	}

	async function open({ url }) {
		if (typeof url !== "string" || url.length === 0) throw new Error("url required");
		const state = await navigate(url);
		const wall = await withPageRetry((page) => page.evaluate(() => (document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile') && (document.body.innerText || "").trim().length < 600 ? "captcha" : undefined)));
		return { url: state.url, title: state.title ?? "", ...(wall ? { wall } : {}) };
	}

	async function map() {
		return withPageRetry(async (page) => {
			await collect(page, { mode: "all", area: "page", maxScan: MAP_MAX_REFS });
			noteDomRefs();
			const raw = await page.evaluate(atlasInPage, { op: "map", arg: {}, cardSelector: CARD_SECRET_SELECTOR });
			const built = buildMap(raw);
			mapped.set(page, new Map(built.sections.map((s) => [s.id, { declaredTotal: s.declaredTotal, label: s.label }])));
			return built;
		});
	}

	async function readExport(exportId) {
		let file;
		try {
			file = JSON.parse(await fs.readFile(`${workspaceDir}/exports/${exportId}.json`, "utf8"));
		} catch {
			throw new Error(`No export "${exportId}" in this workspace. Hint: export the section again.`);
		}
		return file;
	}

	async function read(body) {
		const args = parseReadArgs(body);
		if (args.exportId) {
			const file = await readExport(args.exportId);
			const slice = file.items.slice(args.from - 1, args.from - 1 + args.count).map((text) => ({ text: text.slice(0, args.itemChars), chars: text.length }));
			const part = planPart(slice, { from: args.from, loaded: file.items.length, itemChars: args.itemChars });
			return { section: file.section, label: file.label, from: args.from, to: part.to, loaded: file.items.length, declaredTotal: file.declaredTotal, canLoadMore: false, nextFrom: part.nextFrom, items: part.items };
		}
		return withPageRetry(async (page) => {
			const win = await inPage(page, "window", { id: args.section, from: args.from, to: args.from + args.count - 1, itemChars: args.itemChars });
			const part = planPart(win.items, { from: args.from, loaded: win.total, itemChars: args.itemChars });
			let refs = [];
			if (part.items.length > 0) refs = await refsForWindow(page, args.section, part.items.map((i) => i.n), win.items.length).catch(() => []);
			const items = part.items.map((item, i) => (refs[i]?.length ? { ...item, refs: refs[i] } : item));
			const more = await page.evaluate((id) => Boolean(document.querySelector(`[data-atlas-more="${id}"]`)), args.section);
			const total = declaredOf(page, args.section);
			return { section: args.section, label: labelOf(page, args.section), from: args.from, to: part.to, loaded: win.total, declaredTotal: total, canLoadMore: more || (total !== null && total > win.total), nextFrom: part.nextFrom, items };
		});
	}

	async function find(body) {
		const limit = Number.isInteger(body?.limit) && body.limit >= 1 ? Math.min(body.limit, FIND_MAX_LIMIT) : FIND_DEFAULT_LIMIT;
		if (typeof body?.query !== "string" || body.query.trim() === "") throw new Error("query required");
		return withPageRetry(async (page) => {
			const ids = body.section ? [sectionArg(body.section)] : (await page.evaluate(() => Array.from(document.querySelectorAll("[data-atlas-sec]")).map((e) => e.getAttribute("data-atlas-sec")))).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
			if (ids.length === 0) throw new BrowserV4Error("The page was not mapped yet. Hint: call browser_map first.", "section_missing");
			let searched = 0;
			let totalMatches = 0;
			const matches = [];
			for (const id of ids) {
				const { items } = await inPage(page, "texts", { id, itemChars: ITEM_MAX_CHARS });
				searched += items.length;
				const hit = searchItems(items.map((it, i) => ({ n: i + 1, text: it.text })), body.query, Math.max(0, limit - matches.length));
				totalMatches += hit.total;
				if (hit.matches.length > 0) {
					const ns = hit.matches.map((m) => m.n);
					const win = await inPage(page, "window", { id, ns, itemChars: 1 });
					const refs = await refsForWindow(page, id, ns, win.items.length).catch(() => []);
					hit.matches.forEach((m, i) => matches.push({ section: id, n: m.n, snippet: m.snippet, ...(refs[i]?.[0] ? { ref: refs[i][0].ref } : {}) }));
				}
			}
			return { ...(body.section ? { section: body.section } : {}), searchedItems: searched, totalMatches, matches };
		});
	}

	async function describeTarget(page, ref) {
		const locator = /^(?:f\d{1,3})?a\d/.test(ref) ? (await resolveAxLocator?.(page, ref)) ?? null : await locateRef(page, ref);
		if (!locator) throw new Error(`Ref ${ref} not found: the page changed or the ref is old. Hint: call browser_map or browser_read again.`);
		return locator.evaluate(probeActTarget, CARD_SECRET_SELECTOR);
	}

	async function act(body) {
		const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
		if (!REF_RE.test(ref)) throw new Error(`Invalid ref "${ref}": use a ref from browser_map, browser_read or browser_find.`);
		const intent = body?.intent === "submit" ? "submit" : "browse";
		const verdict = await withPageRetry(async (page) => judgeAct(await describeTarget(page, ref), { action: body.action, text: body.text, intent }));
		if (verdict.verdict === "needs_owner") {
			const state = await withPageRetry(async (page) => ({ url: page.url(), title: await page.title().catch(() => "") }));
			return { ...state, needsOwner: verdict.needsOwner };
		}
		if (verdict.verdict === "needs_submit_intent") throw new BrowserV4Error("This control submits a form that writes data, so it was not clicked. Declare intent submit.", SUBMIT_INTENT_REQUIRED);
		const out = await browserAct({ ref, action: body.action, value: body.text });
		const changes = out.changes ? JSON.stringify(out.changes).slice(0, 1000) : undefined;
		return { url: out.url ?? "", title: out.title ?? "", ...(changes ? { changes } : {}) };
	}

	async function loadOnce(page, id) {
		const before = (await inPage(page, "count", { id })).total;
		const more = page.locator(`[data-atlas-more="${id}"]`).first();
		let method = "scroll";
		if ((await more.count()) > 0 && (await more.isVisible().catch(() => false))) {
			method = "button";
			await more.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
			if (clickElement) await clickElement(page, more, { label: "load more" });
			else await more.click({ timeout: 5000 });
		} else {
			await inPage(page, "scroll", { id });
		}
		const deadline = now() + LOAD_SETTLE_MS;
		let after = before;
		while (now() < deadline) {
			await sleep(200);
			after = (await inPage(page, "count", { id }).catch(() => ({ total: before }))).total;
			if (after > before) {
				await sleep(250); // deixa o lote terminar de entrar
				after = (await inPage(page, "count", { id })).total;
				break;
			}
		}
		return { before, after, method };
	}

	async function loadMore(body) {
		const id = sectionArg(body?.section);
		const times = Number.isInteger(body?.times) ? Math.min(Math.max(1, body.times), LOAD_MORE_MAX_TIMES) : 1;
		return withPageRetry(async (page) => {
			const first = (await inPage(page, "count", { id })).total;
			let last = first;
			let method = "scroll";
			let reachedEnd = false;
			for (let i = 0; i < times; i += 1) {
				const r = await loadOnce(page, id);
				method = r.method;
				if (r.after <= r.before) {
					reachedEnd = true;
					break;
				}
				last = r.after;
			}
			const total = declaredOf(page, id);
			if (total !== null && last >= total) reachedEnd = true;
			return { section: id, before: first, after: last, declaredTotal: total, method, reachedEnd };
		});
	}

	async function exportSection(body) {
		const id = sectionArg(body?.section);
		let stoppedBy = "not_requested";
		if (body?.loadAll === true) {
			const started = now();
			stoppedBy = "limit";
			for (let round = 0; round < EXPORT_MAX_ROUNDS && now() - started < EXPORT_MAX_MS; round += 1) {
				const r = await loadMore({ section: id, times: 1 });
				if (r.reachedEnd) {
					stoppedBy = r.declaredTotal !== null && r.after < r.declaredTotal ? "stalled" : "end";
					break;
				}
			}
		}
		return withPageRetry(async (page) => {
			const { items } = await inPage(page, "texts", { id, itemChars: EXPORT_ITEM_CHARS });
			const exportId = newId();
			const texts = items.map((i) => i.text);
			await fs.mkdir(`${workspaceDir}/exports`, { recursive: true });
			await fs.writeFile(`${workspaceDir}/exports/${exportId}.json`, JSON.stringify({ section: id, label: labelOf(page, id), declaredTotal: declaredOf(page, id), items: texts }));
			return { exportId, path: `${workspaceDir}/exports/${exportId}.json`, section: id, items: texts.length, chars: texts.reduce((n, t) => n + t.length, 0), declaredTotal: declaredOf(page, id), stoppedBy };
		});
	}

	async function wait(body) {
		const out = await browserWait({ for: body.for, value: body.value, timeoutMs: body.timeoutMs });
		return { url: out.url ?? "", met: Boolean(out.met), waitedMs: Math.max(0, Math.round(out.waitedMs ?? 0)) };
	}

	async function tabs(body) {
		if (body.action === "switch") await switchTab(Number(body.tabId));
		else if (body.action === "close") await closeTab(Number(body.tabId));
		else if (body.action !== "list") throw new Error(`Unknown tabs action "${String(body.action)}": use list, switch or close.`);
		return { tabs: (await listTabs()).map((t) => ({ id: String(t.index), url: t.url, title: t.title, active: Boolean(t.active) })) };
	}

	/** Algum campo de cartão (qualquer quadro) com valor? Só lê se há texto, nunca o devolve. */
	async function cardFieldFilled(page) {
		if (typeof page.frames !== "function") return false;
		for (const frame of page.frames()) {
			try {
				const filled = await frame.evaluate((selector) => Array.from(document.querySelectorAll(selector)).some((el) => typeof el.value === "string" && el.value.length > 0), CARD_SECRET_SELECTOR);
				if (filled) return true;
			} catch {
				// quadro navegando: sem leitura
			}
		}
		return false;
	}

	async function screenshot(body) {
		return withPageRetry(async (page) => {
			if (await cardFieldFilled(page)) throw new BrowserV4Error("Screenshot refused: a card field on this page has data in it and the picture would show it. Hint: finish or leave the payment step (the card is cleared when it ends), then take the screenshot.", "card_on_page");
			let buffer;
			if (typeof body?.ref === "string" && body.ref) {
				if (!REF_RE.test(body.ref)) throw new Error(`Invalid ref "${body.ref}".`);
				const locator = await locateRef(page, body.ref);
				if (!locator) throw new Error(`Ref ${body.ref} not found. Hint: call browser_map again.`);
				buffer = await locator.screenshot({ type: "png" });
			} else {
				buffer = await page.screenshot({ type: "png" });
			}
			// PNG: largura e altura estão no cabeçalho (bytes 16-23).
			return { mediaType: "image/png", data: buffer.toString("base64"), width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
		});
	}

	const handlers = { "browser.open": open, "browser.map": map, "browser.read": read, "browser.find": find, "browser.act": act, "browser.load_more": loadMore, "browser.wait": wait, "browser.tabs": tabs, "browser.screenshot": screenshot, "browser.export": exportSection };

	/** `{ kind, params }` → `{ ok: true, data }` ou `{ ok: false, error, code? }` (nunca lança). */
	return async function handle(kind, params) {
		const run = handlers[kind];
		if (!run) return { ok: false, error: `Unknown browser action "${String(kind)}".` };
		try {
			return { ok: true, data: await run(params ?? {}) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}) };
		}
	};
}
