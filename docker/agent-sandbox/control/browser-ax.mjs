// Motor v2 — `browser_snapshot` pela árvore de acessibilidade. Junta captura
// (ax-snapshot), poda (ax-prune), refs (ax-refs) e diff (ax-diff) e faz a
// única parte que precisa da página: a sonda de recorte.
//
// A árvore de acessibilidade NÃO respeita recorte por `overflow:hidden` nem
// `left:-9999px`, então o que vai para o modelo passa por uma sonda barata,
// só nos nós do chunk emitido: ocultos somem (acordeão fechado), aria-hidden
// ganha rótulo, e campo de senha/código nunca mostra o valor.

import { takeAxSnapshot } from "./ax-snapshot.mjs";
import {
	collapseRuns, footerFor, paginateLines, parseAxYaml, probeTargets, pruneNode, pruneNodes, referencedRefs, renderAx, selectViewport,
} from "./ax-prune.mjs";
import { buildRefTable } from "./ax-refs.mjs";
import { toAriaRef } from "./ax-ref-names.mjs";
import { diffAxTrees, flattenForDiff } from "./ax-diff.mjs";
import { formatElementLine } from "./snapshot.mjs";

export const PROBE_CAP = 80;
export const PROBE_TIMEOUT_MS = 800;
const PROBE_CONCURRENCY = 12;
const LINES_MAX = 80;

/** Roda DENTRO do elemento (serializado pelo Playwright): sem closure externa. */
export function probeElement(el) {
	const out = { hidden: "", ariaHidden: false, secret: "" };
	try {
		if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) out.hidden = "css";
		const win = el.ownerDocument.defaultView;
		const rect = el.getBoundingClientRect();
		// Fora do documento (left:-9999px): rolar a página para cima não conta, pois a caixa seria negativa só pelo scroll.
		if (!out.hidden && (rect.right + win.scrollX <= 0 || rect.bottom + win.scrollY <= 0)) out.hidden = "offscreen";
		let node = el;
		for (let i = 0; node && i < 60; i += 1) {
			if (node.getAttribute && node.getAttribute("aria-hidden") === "true") out.ariaHidden = true;
			if (node !== el && !out.hidden) {
				const style = win.getComputedStyle(node);
				const clips = (v) => v === "hidden" || v === "clip";
				const scrolls = (v) => v === "auto" || v === "scroll";
				if (clips(style.overflowX) || clips(style.overflowY) || scrolls(style.overflowX) || scrolls(style.overflowY)) {
					const box = node.getBoundingClientRect();
					if (box.width < 1 || box.height < 1) out.hidden = "clipped";
					else if ((clips(style.overflowX) || clips(style.overflowY)) && rect.width > 0 && (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right)) out.hidden = "clipped";
				}
			}
			node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
		}
		if (el.tagName === "INPUT") {
			const auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
			if (el.type === "password" || /password/.test(auto)) out.secret = "secret";
			else if (/one-time-code/.test(auto)) out.secret = "otp";
		}
	} catch {
		out.failed = true;
	}
	return out;
}

/** ref -> resultado da sonda; ref sem resposta (re-render no meio) fica fora do mapa. */
export async function probeRefs(page, refs, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const results = new Map();
	const queue = [...refs];
	const worker = async () => {
		for (let ref = queue.shift(); ref; ref = queue.shift()) {
			try {
				const out = await page.locator(`aria-ref=${toAriaRef(ref)}`).first().evaluate(probeElement, undefined, { timeout: timeoutMs });
				if (!out.failed) results.set(ref, out);
			} catch {
				// elemento sumiu ou frame navegando: sem sonda, o nó segue como está (campo de valor perde o valor, ver abaixo)
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
	return results;
}

function viewportOf(page) {
	return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1280, height: 720 }));
}

function hiddenSet(probes) {
	const hidden = new Set();
	for (const [ref, result] of probes) if (result.hidden) hidden.add(ref);
	return hidden;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const LIST_ROLES = ["textbox", "searchbox", "combobox", "spinbutton", "slider", "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "clickable"];

/**
 * Linhas no formato do v1 (`[e3] textbox "x" (campo de senha...)`): o muro de login e readLoginFields leem estas.
 * Passou de LINES_MAX: campos de formulário têm prioridade (metade do teto) e o resto entra em ordem, para o
 * formulário de login de uma página densa não ficar de fora do recorte.
 */
export function listLines(nodes, probes, hidden) {
	const items = [];
	const walk = (list) => {
		for (const node of list) {
			if (node.role === "text" || node.role === "__similar") continue;
			if (node.ref && hidden.has(node.ref)) continue;
			if (node.ref && LIST_ROLES.includes(node.role)) {
				const probe = probes.get(node.ref);
				items.push({
					field: FIELD_ROLES.has(node.role) || Boolean(probe?.secret),
					line: formatElementLine({
						ref: node.ref,
						role: node.role,
						name: node.name.slice(0, 80),
						...(probe?.secret === "secret" ? { secret: true } : {}),
						...(probe?.secret === "otp" ? { oneTimeCode: true } : {}),
						...(node.attrs.includes("disabled") ? { disabled: true } : {}),
						...(node.attrs.includes("checked") ? { checked: true } : {}),
					}),
				});
			}
			walk(node.children ?? []);
		}
	};
	walk(nodes);
	if (items.length <= LINES_MAX) return items.map((item) => item.line);
	const keep = new Set();
	items.forEach((item, index) => {
		if (item.field && keep.size < LINES_MAX / 2) keep.add(index);
	});
	items.forEach((_, index) => {
		if (keep.size < LINES_MAX) keep.add(index);
	});
	return items.filter((_, index) => keep.has(index)).map((item) => item.line);
}

function countInteractive(nodes, role = (n) => n.ref && n.role !== "text") {
	let n = 0;
	for (const node of nodes) {
		if (role(node) && node.role !== "__similar") n += 1;
		n += countInteractive(node.children ?? [], role);
	}
	return n;
}

export function createAxEngine({ store, scrollOf, timeoutMs }) {
	/**
	 * Chunk da árvore. Lança AxUnavailableError (o chamador cai no v1).
	 * `ref` mostra os filhos de um nó; senão `area` ("viewport" padrão | "page").
	 */
	async function snapshot(page, { area, ref, offset, limit } = {}) {
		const wantRef = typeof ref === "string" && ref.trim() ? ref.trim() : "";
		const mode = wantRef ? "ref" : area === "page" ? "page" : "viewport";
		const key = `${mode}|${wantRef}`;
		const state = store.get(page);
		const url = page.url();
		const continuing = Number(offset) > 0 && state?.engine === "ax" && state.rendered?.key === key && state.rendered.url === url;
		if (continuing) {
			const slice = paginateLines(state.rendered.lines, { offset, limit });
			return { ...state.rendered.meta, ...shape(slice), cached: true };
		}

		const { yaml, via } = await takeAxSnapshot(page, { timeoutMs });
		const parsed = parseAxYaml(yaml);
		const viewport = await viewportOf(page);
		let nodes;
		let dropped = [];
		let omitted = 0;
		if (wantRef) {
			const target = parsed.byRef.get(wantRef);
			if (!target) throw Object.assign(new Error(`Ref ${wantRef} não está na página agora. Tire um browser_snapshot novo.`), { userFacing: true });
			const pruned = pruneNode(target);
			// O nó pedido aparece com TODOS os filhos (sem "+N similares" no primeiro nível).
			nodes =
				pruned.length === 1 && pruned[0].ref === wantRef
					? [{ ...pruned[0], children: collapseRuns(pruned[0].children, { containerRef: wantRef, expandTop: true }) }]
					: collapseRuns(pruned, { containerRef: wantRef, expandTop: true });
		} else {
			nodes = pruneNodes(parsed.roots);
			if (mode === "viewport" && via === "ai") {
				const selected = selectViewport(nodes, viewport);
				nodes = selected.nodes;
				dropped = selected.dropped;
				omitted = selected.omitted;
			}
			nodes = collapseRuns(nodes);
		}

		// Sonda só no que vai para o modelo (todo campo de valor entra, mesmo vazio: é como se acha senha).
		const targets = probeTargets(nodes);
		const refsToProbe = [...targets.fields, ...[...targets.refs].slice(0, Math.max(0, PROBE_CAP - targets.fields.size))];
		const probes = await probeRefs(page, refsToProbe);
		const hidden = hiddenSet(probes);
		const ariaHidden = new Set([...probes].filter(([, r]) => r.ariaHidden).map(([r]) => r));
		// Valor só sai de campo sondado e não secreto; sonda que falhou = sem valor.
		const values = new Map();
		for (const field of targets.fields) {
			const probe = probes.get(field);
			if (probe) values.set(field, probe.secret || "ok");
		}

		const lines = renderAx(nodes, { values, hidden, ariaHidden, showRefs: referencedRefs(nodes) });
		const footer = mode === "viewport" ? footerFor(dropped, omitted) : [];
		const treeLines = [...lines, ...footer];

		const table = buildRefTable(parsed.byRef);
		store.setAx(page, { table, flat: flattenForDiff(parsed.byRef), viewport, via, url });
		const meta = {
			engine: "ax",
			url,
			title: await page.title().catch(() => ""),
			total: countInteractive(nodes, (n) => n.ref && ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "option", "clickable"].includes(n.role)),
			area: mode === "ref" ? "ref" : mode,
			...(omitted > 0 ? { omitted } : {}),
			...(hidden.size > 0 ? { hidden: hidden.size } : {}),
			...(await scrollOf(page)),
			lines: listLines(nodes, probes, hidden),
		};
		store.setRendered(page, { key, url, lines: treeLines, meta });
		return { ...meta, ...shape(paginateLines(treeLines, { offset, limit })) };
	}

	function shape(slice) {
		return {
			tree: slice.text,
			offset: slice.offset,
			limit: slice.limit,
			nextOffset: slice.nextOffset,
			treeLength: slice.totalLength,
		};
	}

	/**
	 * Depois de um act que o digest diz ter mudado a página: nova árvore, diff
	 * contra a anterior (≤ 25 linhas) e a tabela/mapa atualizados. Nunca lança.
	 */
	async function changesAfter(page) {
		const state = store.get(page);
		if (state?.engine !== "ax") return undefined;
		try {
			const { yaml } = await takeAxSnapshot(page, { timeoutMs });
			const parsed = parseAxYaml(yaml);
			const after = flattenForDiff(parsed.byRef);
			const lines = diffAxTrees(state.flat, after);
			store.setAx(page, { table: buildRefTable(parsed.byRef), flat: after, viewport: state.viewport, via: state.via, url: page.url() });
			return lines;
		} catch {
			return undefined;
		}
	}

	return { snapshot, changesAfter };
}
