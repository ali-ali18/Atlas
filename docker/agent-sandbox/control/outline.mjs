// V5 — saída da leitura (pura, sem navegador): junta os itens de cada frame na
// ordem de leitura, gera o texto/outline, procura trechos e decide quais
// controles são "expandir" (e quais nunca podem ser clicados).
import { describeElement, formatElementLine } from "./snapshot.mjs";

export const READ_DEFAULT_LIMIT = 8000;
export const READ_MAX_LIMIT = 20_000;
export const FIND_MAX_MATCHES = 20;
export const FIND_CONTEXT = 70;
export const QUERY_MAX = 200;

/**
 * `frames`: [{ prefix, label, crossOrigin?, main?, items }] (principal primeiro).
 * `rawByRef`: Map ref -> fatos brutos de collectInteractive.
 * Devolve entradas planas em ordem de leitura; o iframe entra no ponto onde
 * está na página (as marcas `data-atlas-frame` ligam o elemento ao frame).
 */
export function flattenFrames(frames, rawByRef) {
	const byPrefix = new Map(frames.map((frame) => [frame.prefix, frame]));
	const entries = [];
	const seen = new Set();

	function emit(frame) {
		seen.add(frame.prefix);
		for (const item of frame.items) {
			const ctx = { frame: frame.prefix };
			switch (item.t) {
				case "h": {
					const raw = item.ref ? rawByRef.get(item.ref) : undefined;
					entries.push({ ...ctx, kind: "h", level: item.level, text: item.text || raw?.text || "", ref: item.ref, expanded: raw?.expanded });
					break;
				}
				case "p":
					entries.push({ ...ctx, kind: "p", text: item.text, li: Boolean(item.li) });
					break;
				case "i": {
					const raw = rawByRef.get(item.ref);
					if (!raw) break;
					const described = describeElement({ ...raw, inFrame: undefined });
					entries.push({
						...ctx,
						kind: "i",
						ref: item.ref,
						role: described.role,
						text: described.name,
						expanded: described.expanded,
						line: formatElementLine(described),
					});
					break;
				}
				case "lm":
					entries.push({ ...ctx, kind: "lm", text: item.name });
					break;
				case "frame": {
					const child = byPrefix.get(item.mark);
					if (!child || seen.has(child.prefix)) break;
					entries.push({ ...ctx, kind: "frame-open", prefix: child.prefix, label: child.label, crossOrigin: child.crossOrigin });
					emit(child);
					entries.push({ ...ctx, kind: "frame-close", prefix: child.prefix });
					break;
				}
				default:
			}
		}
	}

	const main = frames.find((frame) => frame.main) ?? frames[0];
	if (main) emit(main);
	// Iframe sem marca (removido/recriado no meio da leitura): vai no fim, ainda rotulado.
	for (const frame of frames) {
		if (seen.has(frame.prefix)) continue;
		entries.push({ frame: main?.prefix ?? "", kind: "frame-open", prefix: frame.prefix, label: frame.label, crossOrigin: frame.crossOrigin });
		emit(frame);
		entries.push({ frame: main?.prefix ?? "", kind: "frame-close", prefix: frame.prefix });
	}
	return entries;
}

function frameOpenLine(entry) {
	const name = entry.label ? ` ${JSON.stringify(entry.label)}` : "";
	const origin = entry.crossOrigin ? ` other-origin ${entry.crossOrigin}, untrusted` : "";
	return `[frame ${entry.prefix}${name}${origin}]`;
}

/**
 * Texto da leitura. `outline` traz refs, estado e links; `text` é só a leitura
 * (títulos com #, listas, frames marcados). Linhas repetidas seguidas caem.
 */
export function renderEntries(entries, { view = "outline" } = {}) {
	const outline = view !== "text";
	const lines = [];
	const push = (line) => {
		if (line && lines[lines.length - 1] !== line) lines.push(line);
	};
	for (const entry of entries) {
		switch (entry.kind) {
			case "h": {
				const state = entry.expanded === false ? " (collapsed)" : entry.expanded === true ? " (expanded)" : "";
				const ref = outline && entry.ref ? `[${entry.ref}] ` : "";
				push(`${"#".repeat(entry.level)} ${ref}${entry.text}${outline ? state : ""}`.trimEnd());
				break;
			}
			case "p":
				push(entry.li ? `- ${entry.text}` : entry.text);
				break;
			case "i":
				push(outline ? entry.line : entry.text);
				break;
			case "lm":
				if (outline) push(`[${entry.text}]`);
				break;
			case "frame-open":
				push(frameOpenLine(entry));
				break;
			case "frame-close":
				push(`[/frame ${entry.prefix}]`);
				break;
			default:
		}
	}
	return lines.join("\n");
}

const COLLAPSED = (entry) => (entry.kind === "i" || entry.kind === "h") && entry.expanded === false;

export function countCollapsed(entries) {
	return entries.filter(COLLAPSED).length;
}

/**
 * Coleção de itens parecidos (semanas, módulos): >= 3 títulos/controles cujo
 * texto só difere nos números. Determinístico; alimenta a dica do track_items.
 */
export function detectCollection(entries) {
	const counts = new Map();
	for (const entry of entries) {
		if (entry.kind !== "h" && entry.kind !== "i") continue;
		const stem = String(entry.text ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
		if (stem.length < 3 || !stem.includes("#")) continue;
		counts.set(stem, (counts.get(stem) ?? 0) + 1);
	}
	let best = null;
	for (const [stem, count] of counts) {
		if (count >= 3 && (!best || count > best.count)) best = { stem, count };
	}
	return best;
}

function snippet(text, index, length) {
	const from = Math.max(0, index - FIND_CONTEXT);
	const to = Math.min(text.length, index + length + FIND_CONTEXT);
	return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/**
 * Busca por texto (ou regex) nas entradas, com contexto, a seção (último
 * título) e o ref do elemento (ou do interativo mais próximo). Só enxerga o
 * que está renderizado: seção fechada não entra.
 */
export function findEntries(entries, { query, regex = false, max = FIND_MAX_MATCHES } = {}) {
	const q = String(query ?? "").trim();
	if (!q) throw new Error("query vazia: informe o texto a procurar.");
	if (q.length > QUERY_MAX) throw new Error(`query longa demais (máx. ${QUERY_MAX} caracteres).`);
	let test;
	if (regex) {
		let re;
		try {
			re = new RegExp(q, "i");
		} catch {
			throw new Error("regex inválida em query.");
		}
		test = (text) => {
			const m = re.exec(text);
			return m ? { index: m.index, length: m[0].length } : null;
		};
	} else {
		const needle = q.toLowerCase();
		test = (text) => {
			const index = text.toLowerCase().indexOf(needle);
			return index >= 0 ? { index, length: needle.length } : null;
		};
	}
	const frames = new Map();
	for (const entry of entries) if (entry.kind === "frame-open") frames.set(entry.prefix, entry);
	const matches = [];
	let total = 0;
	let section;
	let sectionRef;
	entries.forEach((entry, i) => {
		if (entry.kind === "h") {
			section = entry.text;
			sectionRef = entry.ref;
		}
		if (entry.kind !== "h" && entry.kind !== "p" && entry.kind !== "i") return;
		const text = String(entry.text ?? "");
		const hit = text ? test(text) : null;
		if (!hit) return;
		total += 1;
		if (matches.length >= max) return;
		const ref = entry.ref;
		let near;
		if (!ref) {
			for (const d of [1, -1, 2, -2]) {
				const other = entries[i + d];
				if (other?.kind === "i" && other.ref) {
					near = other.ref;
					break;
				}
			}
		}
		const frame = entry.frame ? frames.get(entry.frame) : undefined;
		matches.push({
			text: snippet(text, hit.index, hit.length),
			...(ref ? { ref, ...(entry.role ? { role: entry.role } : {}) } : {}),
			...(near ? { near } : {}),
			...(section && entry.kind !== "h" ? { section } : {}),
			...(sectionRef && entry.kind !== "h" ? { sectionRef } : {}),
			...(entry.frame ? { frame: entry.frame, ...(frame?.label ? { frameName: frame.label } : {}), ...(frame?.crossOrigin ? { crossOrigin: frame.crossOrigin } : {}) } : {}),
		});
	});
	return { matches, total };
}

// Rede de segurança, não o critério: o que decide é a estrutura (isExpandable abaixo: aria-expanded,
// summary, aba; nunca submit, form que escreve, menu, link de outra página). A lista só pega o que a
// estrutura não vê (botão de ação com aria-expanded fora de form, em qualquer idioma que o produto use).
// Não aumente a lista por caso: se um controle de escrita passar, ache o sinal estrutural dele.
const WRITE_NAME =
	/\b(submit|send|save|delete|remove|pay|buy|purchase|confirm|finish|complete|mark|sign ?out|log ?out|enviar|salvar|excluir|apagar|remover|pagar|comprar|confirmar|concluir|finalizar|marcar|sair)\b/i;

/**
 * Só controle de expandir/abrir conteúdo: nunca envio, conclusão, menu,
 * navegação nem ação de escrita. Estrutural (aria-expanded, summary, aba) e
 * com uma lista de nomes proibidos como segunda trava.
 */
export function isExpandable(raw) {
	if (!raw || raw.disabled || raw.secret) return false;
	if (raw.tag === "input" || raw.tag === "select" || raw.tag === "textarea") return false;
	if (raw.type === "submit" || raw.type === "reset") return false;
	if (raw.submits) return false;
	// Botão/controle de um form que escreve (action ou POST) só abre conteúdo se aponta um painel (aria-controls), summary ou aba.
	if (raw.inWriteForm && !raw.controls && raw.tag !== "summary" && raw.roleAttr !== "tab") return false;
	if (raw.popup && raw.popup !== "false") return false;
	if (raw.inMenu) return false;
	const role = raw.roleAttr || "";
	if (["combobox", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch"].includes(role)) return false;
	if (raw.tag === "a") {
		const href = String(raw.href ?? "");
		if (href && !href.startsWith("#") && !href.startsWith("javascript:")) return false;
	}
	const isTab = role === "tab" && raw.selected === "false";
	if (raw.expanded !== false && !isTab) return false;
	const name = [raw.ariaLabel, raw.labelledBy, raw.text, raw.title].find((v) => typeof v === "string" && v.trim()) ?? "";
	if (WRITE_NAME.test(name)) return false;
	return true;
}
