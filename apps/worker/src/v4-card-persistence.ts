/**
 * Cards do motor v4 gravados na conversa (issue #163, item 3). Embrulha o `persistEvent` do run: o evento segue para o
 * stream como sempre e, se for um dos quatro cards (aprovação, entrega ao dono, pergunta do bot, recibo), é gravado como
 * mensagem da conversa (`persistAgentV4Card`: validado, sem segredo, uma vez por identidade). Gravar é melhor esforço: uma
 * falha de banco vai para o log (sem o conteúdo do card) e nunca derruba o run nem some com o evento ao vivo.
 * O estado do card (pendente, aprovado, vencido...) não é gravado aqui: o db o deriva na leitura.
 */
import { persistAgentV4Card } from "@workspace/db";
import { isAgentV4EventType, type ComputerUseEvent } from "@workspace/shared";

export type V4CardPersistenceInput = {
	userId: string;
	runId: string;
	conversationId: string | null | undefined;
	persist?: typeof persistAgentV4Card;
	log?: (message: string) => void;
};

export function withV4CardPersistence(input: V4CardPersistenceInput, emit: (event: ComputerUseEvent) => void | Promise<void>): (event: ComputerUseEvent) => Promise<void> {
	const persist = input.persist ?? persistAgentV4Card;
	const log = input.log ?? ((message: string) => console.warn(message));
	return async (event) => {
		await emit(event);
		if (!input.conversationId || !isAgentV4EventType(event.type)) return;
		// O run do evento é o do processador: um card sem `runId` herda o dele (o mapa do kernel já o põe, mas não se confia nisso).
		const card = "runId" in event && event.runId ? event : { ...event, runId: input.runId };
		try {
			await persist(input.userId, input.conversationId, card);
		} catch (error) {
			log(`[v4-cards] não gravei o card ${event.type} do run ${input.runId}: ${error instanceof Error ? error.name : "erro"}`);
		}
	};
}
