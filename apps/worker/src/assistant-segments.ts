import { keepsRevisedDraft, type ComputerUseEvent } from "@workspace/shared";

/**
 * Grava na conversa as falas do assistente que acontecem NO MEIO do run, no instante em que acontecem.
 * Sem isso só o texto final entrava no banco (no fim do run), depois de todas as mensagens que o usuário
 * mandou com o run ativo: ao recarregar, as falas intermediárias sumiam ou iam para depois do usuário.
 *
 * - resposta da triagem (`<turno>-reply<N>`): gravada na hora, com o relógio do servidor;
 * - texto de um passo seguido de tools: gravado quando a chamada de tool chega (o texto já está completo),
 *   com a hora do primeiro delta;
 * - texto do passo final: nunca gravado aqui (o fim do run o grava como antes), então não duplica;
 * - rascunho retirado (`assistant_discard` com motivo que o mantém na tela): gravado como card recolhido
 *   (`writeDraft`), para recarregar mostrar o mesmo que o ao vivo.
 */
export type AssistantSegmentWrite = (text: string, createdAt: Date) => Promise<void>;
export type RevisedDraftWrite = (text: string, reason: string, createdAt: Date) => Promise<void>;

const TRIAGE_REPLY_ID = /-reply\d+$/;

export function createAssistantSegmentRecorder(deps: { write: AssistantSegmentWrite; writeDraft?: RevisedDraftWrite; now?: () => Date }) {
	const now = deps.now ?? (() => new Date());
	let steps: Array<{ id: string; text: string; at: Date }> = [];

	const safeWrite = async (text: string, at: Date) => {
		const clean = text.trim();
		if (!clean) return;
		try {
			await deps.write(clean, at);
		} catch (error) {
			// Melhor esforço: a fala continua visível ao vivo e o fim do run grava o texto final.
			console.error("persist assistant segment failed", error instanceof Error ? error.message : "unknown");
		}
	};

	return {
		async observe(event: ComputerUseEvent): Promise<void> {
			if (event.type === "assistant_delta") {
				if (TRIAGE_REPLY_ID.test(event.id)) {
					await safeWrite(event.delta, now());
					return;
				}
				const current = steps.find((item) => item.id === event.id);
				if (current) current.text += event.delta;
				else steps.push({ id: event.id, text: event.delta, at: now() });
				return;
			}
			if (event.type === "assistant_discard") {
				// Com id: só o passo retirado (um passo sem texto não leva a fala de outro). Sem id: o último, como antes.
				const removed = event.id ? steps.filter((item) => item.id === event.id) : steps.slice(-1);
				if (event.id) steps = steps.filter((item) => item.id !== event.id);
				else steps.pop();
				if (!deps.writeDraft || !event.reason || !keepsRevisedDraft(event.reason)) return;
				for (const item of removed) {
					const clean = item.text.trim();
					if (!clean) continue;
					try {
						await deps.writeDraft(clean, event.reason, item.at);
					} catch (error) {
						console.error("persist revised draft failed", error instanceof Error ? error.message : "unknown");
					}
				}
				return;
			}
			if (event.type === "tool_call") {
				const ready = steps;
				steps = [];
				for (const item of ready) await safeWrite(item.text, item.at);
			}
		},
	};
}
