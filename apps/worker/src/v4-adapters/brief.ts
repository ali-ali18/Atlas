// Fontes e cartão do plano do dia (brief) do v4 no worker (F7.2). Cada fonte é uma porta mínima do `@workspace/agent`;
// aqui só se liga ao db com o `userId` do RUN (nunca do modelo). O e-mail NÃO é daqui: a frente de e-mail entrega uma
// `BriefEmailSource` (`listRecent`) e `buildV4Registry` a recebe em `briefEmail`; sem ela o brief segue sem a seção.
import type { BriefCards, BriefDeliveries, BriefOpenTasks } from "@workspace/agent";
import { getConversationTaskList, listAgendaItems, listPurchases, persistConversationCardFromEvent } from "@workspace/db";
import type { ComputerUseEvent } from "@workspace/shared";
import { sanitizeErrorMessage } from "@workspace/shared";

export type V4BriefDeps = {
	listPurchases: typeof listPurchases;
	listAgendaItems: typeof listAgendaItems;
	conversationTasks: typeof getConversationTaskList;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4BriefDeps: V4BriefDeps = {
	listPurchases,
	listAgendaItems,
	conversationTasks: getConversationTaskList,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4BriefScope = {
	botId?: string | null;
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

export function createV4Brief(input: { scope: V4BriefScope; deps?: V4BriefDeps }): { deliveries: BriefDeliveries; tasks?: BriefOpenTasks; cards: BriefCards } {
	const deps = input.deps ?? realV4BriefDeps;
	const { scope } = input;
	const conversationId = scope.conversationId ?? null;

	// Compras com vigia de entrega ATIVO (pendente ou pausado): o vigia ligado à compra ainda está na agenda do dono.
	const deliveries: BriefDeliveries = {
		async listTracked(userId, options) {
			const [purchases, active] = await Promise.all([deps.listPurchases(userId, { limit: 30, ...(scope.botId && { botId: scope.botId }) }), deps.listAgendaItems(userId, { limit: 100 })]);
			const watching = new Set(active.map((item) => item.id));
			return purchases
				.filter((p) => p.deliveryWatchId && watching.has(p.deliveryWatchId))
				.slice(0, options.limit)
				.map((p) => ({ merchant: p.merchant, items: p.items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)), purchasedAt: p.purchasedAt, ...(p.orderNumber && { orderNumber: p.orderNumber }), ...(p.trackingCode && { trackingCode: p.trackingCode }) }));
		},
	};

	const tasks: BriefOpenTasks | undefined = conversationId
		? {
				async list(userId, options) {
					const list = await deps.conversationTasks(userId, conversationId);
					return (list ?? []).filter((t) => t.status !== "completed").slice(0, options.limit).map((t) => t.content);
				},
			}
		: undefined;

	const shown = new Set<string>();
	const cards: BriefCards = {
		async show(_userId, runId, card) {
			if (shown.has(card.planId)) return;
			shown.add(card.planId);
			const event: ComputerUseEvent = { type: "day_plan", ...card, runId };
			if (conversationId) {
				await deps.persistCard(conversationId, event).catch((error: unknown) => {
					(scope.log ?? console.warn)(`[engine-v4] cartão "day_plan" não gravado na conversa: ${sanitizeErrorMessage(error).slice(0, 200)}`);
				});
			}
			await scope.emit(event);
		},
	};
	return { deliveries, ...(tasks && { tasks }), cards };
}
