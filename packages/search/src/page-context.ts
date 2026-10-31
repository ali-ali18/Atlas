/**
 * Texto visível em volta de um elemento (contexto): compartilhado pelo localizador (`page-value.ts`) e pelo leitor
 * de alertas (`alert-source.ts`), que guarda a âncora do valor e confere se ela continua perto dele.
 */
import { sanitizeAlertExternalText } from "@workspace/shared";

export const CONTEXT_CHARS = 160;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "head", "iframe", "object", "canvas", "title"]);

export function squeeze(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

export function tagOf(el: Element): string {
	return (el.localName || el.tagName).toLowerCase();
}

export function isSkipped(el: Element): boolean {
	if (SKIP_TAGS.has(tagOf(el))) return true;
	if (el.hasAttribute("hidden")) return true;
	return /display\s*:\s*none/i.test(el.getAttribute("style") ?? "");
}

/**
 * Texto visível de um elemento para contexto e proximidade: sem script/estilo/escondido, com espaço entre elementos
 * (para ler "Galaxy X 256 GB R$ 3.299,00") e parando em `cap` caracteres, então nunca lê o documento inteiro.
 * Com `mark`, devolve também onde o elemento marcado começa e termina no texto.
 */
export function visibleText(el: Element, cap: number, mark?: Element): { text: string; start: number; end: number } {
	const state = { text: "", start: -1, end: -1 };
	const collect = (node: Node, depth: number): void => {
		if (state.text.length >= cap || depth > 80) return;
		if (node === mark) state.start = state.text.length;
		if (node.nodeType === 3) {
			state.text += node.nodeValue ?? "";
			return;
		}
		if (node.nodeType !== 1 || isSkipped(node as Element)) return;
		state.text += " ";
		for (let child = node.firstChild; child; child = child.nextSibling) collect(child, depth + 1);
		state.text += " ";
		if (node === mark) state.end = state.text.length;
	};
	collect(el, 0);
	return state;
}


export const isPageRoot = (el: Element | null): boolean => !el || tagOf(el) === "body" || tagOf(el) === "html";

/** ~120 caracteres de texto visível em volta: o que vem antes do elemento, o valor e o que vem depois. */
export function contextAround(el: Element, reading: string): string {
	let anchor: Element = el;
	for (let level = 0; level < 3 && !isPageRoot(anchor.parentElement); level += 1) {
		if (squeeze(visibleText(anchor, 600).text).length >= reading.length + 15) break;
		anchor = anchor.parentElement as Element;
	}
	const { text, start, end } = visibleText(anchor, 1500, el);
	if (start < 0 || end < start) return sanitizeAlertExternalText(squeeze(text), CONTEXT_CHARS);
	const before = squeeze(text.slice(0, start)).slice(-60);
	const after = squeeze(text.slice(end)).slice(0, 50);
	return sanitizeAlertExternalText(`${before} ${squeeze(text.slice(start, end))} ${after}`, CONTEXT_CHARS);
}

