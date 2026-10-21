/**
 * Injeta um resumo curto dos artefatos de runs anteriores na mesma conversa,
 * para guiar artifact_read. Usado quando um novo run começa numa conversa
 * que já tem resultados guardados.
 */

import type { ChatMessage } from "@workspace/shared";

/**
 * Cria uma mensagem de sistema listando artefatos recentes da conversa.
 * Usada para informar o modelo sobre o que pode ler com artifact_read.
 *
 * @param artifacts lista de {id, name?} dos artefatos recentes
 * @returns mensagem de sistema, ou null se vazio
 */
export function buildConversationArtifactsNote(
	artifacts: Array<{ id: string; name?: string }>,
): ChatMessage | null {
	if (!artifacts || artifacts.length === 0) return null;

	// Até 5, determinístico (primeiro que retorna do db)
	const ids = artifacts.slice(0, 5);
	const parts = ids.map((a) => {
		// Truncate name to 80 chars and replace newlines with spaces
		let name = "";
		if (a.name) {
			name = ` — ${a.name.replace(/\n/g, " ").slice(0, 80)}`;
		}
		return `${a.id}${name}`;
	});

	const note = `Earlier results in this conversation (read with artifact_read): ${parts.join("; ")}.`;
	return { role: "system", content: note };
}

export type ConversationArtifactsSummary = { id: string; name?: string; kind: string };

/**
 * Insere a nota logo antes da última mensagem de usuário (o objetivo atual).
 * Se a última mensagem não for do usuário, a nota vai ao final.
 */
export function insertBeforeLastUser(messages: ChatMessage[], note: ChatMessage): ChatMessage[] {
	const last = messages.length - 1;
	const lastMessage = messages[last];
	if (lastMessage && lastMessage.role === "user") {
		return [...messages.slice(0, last), note, lastMessage];
	}
	return [...messages, note];
}

/**
 * Nota do turno DEPOIS da fala do usuário (e das notas que já vieram): o que vale só neste pedido não entra no
 * meio do prefixo já enviado. O runtime grava a conversa como foi enviada, então os turnos seguintes repetem
 * byte a byte o que o provedor já viu e o cache de prompt continua valendo.
 */
export function appendTurnNote(messages: ChatMessage[], note: ChatMessage): ChatMessage[] {
	return [...messages, note];
}
