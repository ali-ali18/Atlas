// Portas de compras do v4 no worker (F6.1 e F6.5): a página do produto (HTML bruto, com as proteções SSRF/robots/limite do
// extrator do `@workspace/search`), o cartão `product` e a compra do dono no db. Montado POR RUN: bot, conversa e `emit`
// vêm do run, nunca de argumento do modelo. Toda função do db recebe o `userId` do run.
//
// As FOTOS são só URLs dentro do cartão: o servidor não as baixa. Quem as desenha é o app (http/https, sem cookie).
import type { ProductCardPayload, ProductPages, Purchases, ShoppingPorts } from "@workspace/agent";
import { attachDeliveryWatch, listPurchases, persistConversationCardFromEvent, recordPurchase, type PurchaseRecord } from "@workspace/db";
import { fetchPageHtml } from "@workspace/search";
import type { ComputerUseEvent, PurchaseView } from "@workspace/shared";

export type V4ShoppingDeps = {
	fetchHtml: (url: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ url: string; html: string }>;
	record: typeof recordPurchase;
	attachWatch: typeof attachDeliveryWatch;
	list: typeof listPurchases;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4ShoppingDeps: V4ShoppingDeps = {
	fetchHtml: (url, options) => fetchPageHtml(url, options),
	record: recordPurchase,
	attachWatch: attachDeliveryWatch,
	list: listPurchases,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4ShoppingScope = {
	conversationId?: string | null;
	botId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

const FETCH_ERROR_TEXT: Readonly<Record<string, string>> = {
	blocked: "The page could not be fetched (blocked, not found or unreachable).",
	needs_login: "The page needs a login or denied access.",
	timeout: "The page took too long to answer.",
	robots_denied: "The site does not allow automated reading of this page.",
	rate_limited: "The site is limiting requests; try again later.",
};
const PAGE_TIMEOUT_MS = 20_000;

function fetchErrorText(error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "blocked";
	return FETCH_ERROR_TEXT[code] ?? FETCH_ERROR_TEXT.blocked!;
}

const toView = ({ deliveryWatchId: _watch, ...view }: PurchaseRecord): PurchaseView => {
	void _watch;
	return view;
};

export function createV4Shopping(input: { scope: V4ShoppingScope; deps?: V4ShoppingDeps }): ShoppingPorts {
	const deps = input.deps ?? realV4ShoppingDeps;
	const { scope } = input;
	// Cartão gravado e emitido uma vez por identidade dentro do run; a retomada cai no dedupe do db e do merge da conversa.
	const shown = new Set<string>();
	async function showCard(key: string, event: ComputerUseEvent): Promise<void> {
		if (shown.has(key)) return;
		shown.add(key);
		if (scope.conversationId) {
			await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
				(scope.log ?? console.warn)(`[engine-v4] cartão "${event.type}" não gravado na conversa: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
			});
		}
		await scope.emit(event);
	}

	const pages: ProductPages = {
		async fetchHtml(_userId, url, signal) {
			try {
				return await deps.fetchHtml(url, { ...(signal && { signal }), timeoutMs: PAGE_TIMEOUT_MS });
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new Error(fetchErrorText(error));
			}
		},
	};

	const purchases: Purchases = {
		async record(userId, runId, purchase) {
			const saved = await deps.record({ userId, botId: scope.botId ?? null, conversationId: scope.conversationId ?? null, sourceRunId: runId, purchase });
			return { purchase: toView(saved.purchase), duplicate: saved.duplicate };
		},
		async attachDeliveryWatch(userId, purchaseId, watchId) {
			await deps.attachWatch(userId, purchaseId, watchId);
		},
		async show(_userId, runId, purchase) {
			const { id, botId: _bot, createdAt: _created, ...rest } = purchase;
			void _bot;
			void _created;
			await showCard(`purchase:${id}`, { type: "purchase", purchaseId: id, ...rest, runId });
		},
		async list(userId, options) {
			return (await deps.list(userId, { limit: options?.limit ?? 20, ...(scope.botId && { botId: scope.botId }) })).map(toView);
		},
	};

	return {
		pages,
		purchases,
		cards: {
			async show(_userId, runId, card: ProductCardPayload) {
				await showCard(`product:${card.cardId}`, { type: "product", ...card, runId });
			},
		},
	};
}
