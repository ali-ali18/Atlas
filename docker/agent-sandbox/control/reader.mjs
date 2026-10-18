// V5 — `read` e `find`: leitura da página inteira (todos os frames, shadow DOM,
// ordem de leitura), com `expand` para abrir acordeões e ler o conteúdo de
// cada seção. Playwright entra por `withPageRetry` e pelas funções do
// createRefActions (collect/locateRef/observeAction), então roda com página
// falsa nos testes.
import { normalizeText, paginateText } from "./text-page.mjs";
import {
	READ_DEFAULT_LIMIT,
	READ_MAX_LIMIT,
	FIND_MAX_MATCHES,
	countCollapsed,
	detectCollection,
	findEntries,
	flattenFrames,
	isExpandable,
	renderEntries,
} from "./outline.mjs";
import { readPageInPage } from "./read-page.mjs";
import { describeElement } from "./snapshot.mjs";

export const EXPAND_MAX_SECTIONS = 30;
export const SECTION_MAX_CHARS = 3000;
export const EXPAND_BUDGET_MS = 45_000;
export const READ_TOTAL_MAX = 400_000;
const READ_MAX_REFS = 800;
const CACHE_TTL_MS = 60_000;
const REF_PATTERN = /^(?:f\d{1,3})?e\d{1,5}$/;

/** Valida o corpo de /browser/read. `expand`: "all" | ["e1", ...] | omitido. */
export function parseReadArgs(body) {
	const view = body?.view === "text" ? "text" : "outline";
	let expand;
	if (body?.expand === "all" || body?.expand === true) expand = "all";
	else if (Array.isArray(body?.expand)) {
		const refs = body.expand.map((ref) => String(ref).trim());
		const bad = refs.find((ref) => !REF_PATTERN.test(ref));
		if (bad !== undefined) throw new Error(`ref inválido "${bad}" em expand: use refs de browser_read/browser_snapshot (ex.: e12).`);
		if (refs.length > 0) expand = refs.slice(0, EXPAND_MAX_SECTIONS);
	}
	return { view, expand, offset: body?.offset, limit: body?.limit };
}

async function openState(locator) {
	try {
		return await locator.evaluate((el) => {
			if (el.tagName === "SUMMARY") return el.parentElement?.open ? "open" : "closed";
			if (el.getAttribute("aria-expanded") === "true" || el.getAttribute("aria-selected") === "true") return "open";
			return "closed";
		});
	} catch {
		return "unknown";
	}
}

const clipText = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createPageReader({ withPageRetry, registry, collect, locateRef, observeAction, clickElement, now = Date.now }) {
	let cache = null;

	/** Numera o que falta (sem renumerar o que já tem ref) e lê todos os frames. */
	async function readEntries(page) {
		const list = registry.list(page);
		// O iframe é marcado para a leitura saber onde o conteúdo dele entra na página.
		for (const entry of list) {
			if (entry.main) continue;
			try {
				const handle = await entry.frame.frameElement();
				await handle.evaluate((el, id) => el.setAttribute("data-atlas-frame", id), entry.prefix);
				await handle.dispose?.();
			} catch {
				// frame sumiu: o conteúdo dele vai no fim, ainda rotulado
			}
		}
		const raws = await collect(page, { mode: "all", area: "page", maxScan: READ_MAX_REFS });
		const rawByRef = new Map(raws.map((raw) => [raw.ref, raw]));
		const frames = [];
		for (const entry of list) {
			let out;
			try {
				out = await entry.frame.evaluate(readPageInPage, {});
			} catch {
				continue; // frame navegando/inacessível
			}
			frames.push({ prefix: entry.prefix, label: entry.label, crossOrigin: entry.crossOrigin, main: entry.main, items: out.items, truncated: out.truncated });
		}
		const entries = flattenFrames(frames, rawByRef);
		return { entries, raws, rawByRef, frames: frames.length, nodeCapped: frames.some((frame) => frame.truncated) };
	}

	/** Conteúdo de uma seção recém-aberta: o painel controlado pelo botão; sem painel, o texto novo do diff. */
	async function readSection(page, raw, observed, snap, view) {
		const parsedPrefix = /^(f\d+)e/.exec(raw.ref)?.[1] ?? "";
		const frame = registry.frameOf(page, parsedPrefix);
		let lines = "";
		if (frame) {
			try {
				const fresh = await collect(page, { mode: "all", area: "page", maxScan: 200 });
				for (const item of fresh) snap.rawByRef.set(item.ref, item);
				const out = await frame.evaluate(readPageInPage, { panelOf: raw.ref });
				if (out.items.length > 0) {
					const entries = flattenFrames([{ prefix: parsedPrefix, label: "", main: true, items: out.items }], snap.rawByRef);
					lines = renderEntries(entries, { view });
				}
			} catch {
				// cai no diff
			}
		}
		if (!lines && observed.diff?.added?.length > 0) {
			const name = describeElement(raw).name;
			lines = observed.diff.added.filter((block) => block !== name).join("\n");
		}
		return lines;
	}

	async function expandSections(page, snap, { which, view }) {
		const deadline = now() + EXPAND_BUDGET_MS;
		const candidates = snap.raws.filter((raw) => isExpandable(raw) && (!which || which.includes(raw.ref)));
		const out = { sections: [], failed: 0, skipped: 0, stoppedBy: undefined, total: candidates.length };
		for (const [index, raw] of candidates.entries()) {
			if (out.sections.length >= EXPAND_MAX_SECTIONS) {
				out.skipped = candidates.length - index;
				out.stoppedBy = "limit";
				break;
			}
			if (now() > deadline) {
				out.skipped = candidates.length - index;
				out.stoppedBy = "time";
				break;
			}
			const locator = await locateRef(page, raw.ref);
			if (!locator || (await openState(locator)) === "open") continue;
			let observed;
			try {
				observed = await observeAction(page, async () => {
					await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
					if (clickElement) return clickElement(page, locator, { label: raw.ref });
					return locator.click({ timeout: 4000 });
				});
			} catch {
				out.failed += 1;
				continue;
			}
			// Mudou de página: o que era "expandir" não era. Para e deixa o que já leu.
			if (observed.effect?.navigated || observed.diff?.reloaded) {
				out.stoppedBy = "navigation";
				out.skipped = candidates.length - index - 1;
				break;
			}
			const content = await readSection(page, raw, observed, snap, view);
			const name = describeElement(raw).name || raw.ref;
			out.sections.push({ ref: raw.ref, name, content: clipText(content, SECTION_MAX_CHARS), cut: content.length > SECTION_MAX_CHARS });
		}
		return out;
	}

	function expansionText(expansion, view) {
		if (expansion.sections.length === 0) return "";
		const blocks = expansion.sections.map((section) => {
			const head = view === "text" ? `### ${section.name}` : `### ${section.name} [${section.ref}]`;
			const body = section.content || "(no new text)";
			return `${head}\n${body}${section.cut ? "\n(section cut: ask for it alone with expand=[ref] and a larger limit)" : ""}`;
		});
		return `\n\n[expanded sections: ${expansion.sections.length}]\n${blocks.join("\n\n")}`;
	}

	/** POST /browser/read */
	async function readPage(body) {
		const args = parseReadArgs(body);
		const key = JSON.stringify([args.view, args.expand ?? null]);
		const asked = Number(args.offset);
		const limits = { defaultLimit: READ_DEFAULT_LIMIT, maxLimit: READ_MAX_LIMIT, breakOnLine: true };
		// Continuação da mesma leitura: serve do cache (não reabre acordeão nem relê a página).
		if (asked > 0 && cache && cache.key === key && now() - cache.at < CACHE_TTL_MS) {
			return { ...cache.meta, ...paginateText(cache.text, { offset: args.offset, limit: args.limit }, limits), cached: true };
		}
		return withPageRetry(async (page) => {
			const snap = await readEntries(page);
			let text = renderEntries(snap.entries, { view: args.view });
			const collapsed = countCollapsed(snap.entries);
			const similar = detectCollection(snap.entries);
			let expansion;
			if (args.expand) {
				expansion = await expandSections(page, snap, { view: args.view, which: args.expand === "all" ? undefined : args.expand });
				text += expansionText(expansion, args.view);
			}
			let full = normalizeText(text);
			let capped = false;
			if (full.length > READ_TOTAL_MAX) {
				full = full.slice(0, READ_TOTAL_MAX);
				capped = true;
			}
			const meta = {
				url: page.url(),
				title: await page.title(),
				view: args.view,
				frames: snap.frames,
				collapsed,
				...(similar ? { similar: { count: similar.count } } : {}),
				...(expansion
					? {
							expanded: {
								opened: expansion.sections.length,
								failed: expansion.failed,
								skipped: expansion.skipped,
								...(expansion.stoppedBy ? { stoppedBy: expansion.stoppedBy } : {}),
							},
						}
					: {}),
				...(snap.nodeCapped || capped ? { capped: true } : {}),
			};
			cache = { key, at: now(), text: full, meta };
			return { ...meta, ...paginateText(full, { offset: args.offset, limit: args.limit }, limits) };
		}, { tries: 3 });
	}

	/** POST /browser/find */
	async function findText(body) {
		const query = String(body?.query ?? "");
		const asked = Number(body?.max);
		const max = Number.isFinite(asked) && asked > 0 ? Math.min(FIND_MAX_MATCHES, Math.floor(asked)) : FIND_MAX_MATCHES;
		// Valida antes de abrir o navegador (query vazia/regex ruim).
		findEntries([], { query, regex: body?.regex === true, max });
		return withPageRetry(async (page) => {
			const snap = await readEntries(page);
			const found = findEntries(snap.entries, { query, regex: body?.regex === true, max });
			return {
				url: page.url(),
				title: await page.title(),
				query: query.trim(),
				total: found.total,
				matches: found.matches,
				frames: snap.frames,
				collapsed: countCollapsed(snap.entries),
			};
		}, { tries: 3 });
	}

	return { readPage, findText, readEntries, expandSections };
}
