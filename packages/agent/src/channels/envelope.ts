import type { LlmMessage } from "../ports/llm.js";
import { escapeReserved } from "./escape.js";
import type { RunNonce } from "./nonce.js";

// Constrói as mensagens do modelo a partir de entradas TIPADAS. A origem vem do
// campo `kind`/`source`, nunca de olhar o texto (60-agente: sem regex de decisão).
//
// Layout em 3 blocos, só de acréscimo (03 §2):
//   1. system estável (prompt + parágrafo de canais, sem nonce)
//   2. system `[context]` (traz o id da sessão = nonce, estável durante o run)
//   3. histórico e, no fim, os blocos `<atlas:runtime>` voláteis

export type DataSource =
	| "email"
	| "web"
	| "file"
	| `tool:${string}`
	| `mcp:${string}`
	| `bot:${string}`;

export type ChannelInput =
	| { kind: "owner"; text: string }
	| { kind: "runtime"; text: string }
	| { kind: "data"; source: DataSource; text: string; toolCallId?: string };

/** Atributo seguro: só o que cabe num nome de origem; o resto vira `_`. */
export function sanitizeSource(source: string): string {
	const cleaned = source.replace(/[^A-Za-z0-9._:-]/g, "_");
	return cleaned.slice(0, 80) || "_";
}

export function renderRuntimeBlock(nonce: RunNonce, text: string): string {
	return `<atlas:runtime id="${nonce}">\n${text}\n</atlas:runtime>`;
}

export function renderDataBlock(source: DataSource, text: string): string {
	return `<data source="${sanitizeSource(source)}" trust="untrusted">\n${escapeReserved(text)}\n</data>`;
}

/** Fala do dono: limpa, sem prefixo; só o escape (identidade se não há sequência reservada). */
export function ownerMessage(text: string): LlmMessage {
	return { role: "user", content: escapeReserved(text) };
}

export function channelMessage(nonce: RunNonce, input: ChannelInput): LlmMessage {
	switch (input.kind) {
		case "owner":
			return ownerMessage(input.text);
		case "runtime":
			// Texto do runtime é confiável (montado pelo código): sem escape.
			return { role: "user", content: renderRuntimeBlock(nonce, input.text) };
		case "data": {
			const content = renderDataBlock(input.source, input.text);
			return input.toolCallId !== undefined
				? { role: "tool", toolCallId: input.toolCallId, content }
				: { role: "user", content };
		}
	}
}

/**
 * Bloco 2. Traz o id da sessão que o prompt estável manda procurar aqui. O corpo
 * (memória, caderno, índice) é conteúdo do dono/derivado: passa pelo escape.
 */
export function buildContextBlock(nonce: RunNonce, sections: readonly string[]): LlmMessage {
	const body = sections.map(escapeReserved).join("\n\n");
	return { role: "system", content: `[context]\nsession id: ${nonce}${body ? `\n\n${body}` : ""}` };
}

export type RunMessagesInput = {
	nonce: RunNonce;
	/** Bloco 1, igual em todos os runs (cache). */
	stableSystem: string;
	/** Seções do bloco 2. */
	contextSections: readonly string[];
	/** Histórico em ordem, já tipado. */
	history: readonly ChannelInput[];
	/** Bloco 3: notas voláteis do runtime, no fim. */
	runtimeNotes?: readonly string[];
};

export function buildRunMessages(input: RunMessagesInput): LlmMessage[] {
	return [
		{ role: "system", content: input.stableSystem },
		buildContextBlock(input.nonce, input.contextSections),
		...input.history.map((h) => channelMessage(input.nonce, h)),
		...(input.runtimeNotes ?? []).map((text) => channelMessage(input.nonce, { kind: "runtime", text })),
	];
}
