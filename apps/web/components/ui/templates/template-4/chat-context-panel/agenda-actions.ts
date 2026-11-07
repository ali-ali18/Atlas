import type { AgendaAction, AgendaChangeResponse, AgendaItemView } from "@workspace/shared";
import { AtlasApiError } from "@/lib/atlas-api";

/** O que o cartão faz com a resposta: trocar o item, recarregar (o combinado já mudou) ou avisar do erro. */
export type AgendaActionOutcome = { result: "ok"; item: AgendaItemView } | { result: "gone" } | { result: "error" };

/**
 * Pausa, retoma ou cancela chamando o cliente da API (injetado para teste). 404 (já não existe) e 409 (a ação não cabe
 * mais no estado dele) viram `gone`: o item mudou por outro caminho (o bot encerrou, outra aba cancelou) e a lista recarrega.
 */
export async function performAgendaAction(
	change: (id: string, action: AgendaAction) => Promise<AgendaChangeResponse>,
	item: Pick<AgendaItemView, "id">,
	action: AgendaAction,
): Promise<AgendaActionOutcome> {
	try {
		const { item: changed } = await change(item.id, action);
		return { result: "ok", item: changed };
	} catch (error) {
		return error instanceof AtlasApiError && (error.status === 404 || error.status === 409) ? { result: "gone" } : { result: "error" };
	}
}
