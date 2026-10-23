import { CONNECTOR_GUIDE_NOTE_PREFIX, connectorGuideNote, type ConnectorKind } from "@workspace/shared";

/**
 * Guia do conector no run: injeção sob demanda (uma vez por run e por conexão) e
 * detecção de lições (falha seguida de sucesso no mesmo conector). Puro: o runtime
 * só liga as pontas. O guia é DADO não confiável; entra rotulado, depois das regras.
 */

export type GuideRef = { kind: ConnectorKind; id: string; name: string; text: string | null };

/** Quantas lições (falha → sucesso) um run pode propor. */
export const LESSON_MAX_PER_RUN = 2;

export type ConnectorGuideInjector = {
	/** Notas novas para as conexões usadas agora (vazio se já injetadas ou sem guia). */
	notesFor(refs: readonly (GuideRef | null | undefined)[]): string[];
	/** Marca como já injetadas as notas presentes na conversa (retomada de checkpoint). */
	seed(messages: ReadonlyArray<{ role: string; content?: unknown }>): void;
};

export function createConnectorGuideInjector(
	known: ReadonlyArray<{ id: string; name: string }> = [],
): ConnectorGuideInjector {
	const injected = new Set<string>();
	return {
		notesFor(refs) {
			const notes: string[] = [];
			for (const ref of refs) {
				if (!ref?.text?.trim()) continue;
				const key = `${ref.kind}:${ref.id}`;
				if (injected.has(key)) continue;
				injected.add(key);
				notes.push(connectorGuideNote(ref.name, ref.text));
			}
			return notes;
		},
		seed(messages) {
			for (const message of messages) {
				// O guia pode estar numa nota de sistema antiga ou anexado a um resultado de tool.
				if ((message.role !== "system" && message.role !== "tool") || typeof message.content !== "string") continue;
				if (!message.content.includes(CONNECTOR_GUIDE_NOTE_PREFIX)) continue;
				for (const item of known) {
					if (message.content.includes(`${CONNECTOR_GUIDE_NOTE_PREFIX}${item.name} (`)) {
						injected.add(`mcp:${item.id}`);
						injected.add(`api:${item.id}`);
					}
				}
			}
		},
	};
}

export type LessonCandidate = {
	kind: ConnectorKind;
	connectionId: string;
	failed: { tool: string; args: string; error: string };
	succeeded: { tool: string; args: string };
};

/** Resultado "ok" que o runtime já anotou com dica de falha (filtro opcional vazio, id interno). */
const HINTED_FAILURE = /Empty result with filters \{|Not found\. The argument "/;

function stringify(args: unknown): string {
	try {
		return JSON.stringify(args ?? {}).slice(0, 600);
	} catch {
		return "{}";
	}
}

export function createLessonTracker(max = LESSON_MAX_PER_RUN) {
	const pending = new Map<string, { tool: string; args: string; error: string }>();
	const proposed = new Set<string>();
	let emitted = 0;
	return {
		/** Registra uma chamada; devolve a lição candidata quando um sucesso (args diferentes) segue uma falha do mesmo conector. */
		record(input: { kind: ConnectorKind; connectionId: string; tool: string; args: unknown; ok: boolean; text: string }): LessonCandidate | null {
			const key = `${input.kind}:${input.connectionId}`;
			const args = stringify(input.args);
			const failed = !input.ok || HINTED_FAILURE.test(input.text);
			if (failed) {
				if (!pending.has(key)) pending.set(key, { tool: input.tool, args, error: input.text.slice(0, 500) });
				return null;
			}
			const before = pending.get(key);
			if (!before || before.args === args && before.tool === input.tool) return null;
			pending.delete(key);
			if (emitted >= max || proposed.has(key)) return null;
			emitted += 1;
			proposed.add(key);
			return { kind: input.kind, connectionId: input.connectionId, failed: before, succeeded: { tool: input.tool, args } };
		},
	};
}
