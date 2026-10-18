"use client";

/** Evento que qualquer tela dispara para abrir o Marketplace (ex.: card de conexão sem login de um clique). */
export const OPEN_MARKETPLACE_EVENT = "atlas:open-marketplace";

export function requestMarketplace(target: EventTarget = window) {
	target.dispatchEvent(new Event(OPEN_MARKETPLACE_EVENT));
}

/** Escuta o pedido acima. Devolve o cancelamento. */
export function listenForMarketplace(onOpen: () => void, target: EventTarget = window): () => void {
	target.addEventListener(OPEN_MARKETPLACE_EVENT, onOpen);
	return () => target.removeEventListener(OPEN_MARKETPLACE_EVENT, onOpen);
}

/** Pedido para abrir o dialog "MCP personalizado" já preenchido (card `propose_custom_mcp`). */
export const OPEN_CUSTOM_MCP_EVENT = "atlas:open-custom-mcp";

export type CustomMcpDraft = { name: string; url: string; auth: "oauth" | "apiKey" | "none" };

export function requestCustomMcp(draft: CustomMcpDraft, target: EventTarget = window) {
	target.dispatchEvent(new CustomEvent<CustomMcpDraft>(OPEN_CUSTOM_MCP_EVENT, { detail: draft }));
}

export function listenForCustomMcp(onOpen: (draft: CustomMcpDraft) => void, target: EventTarget = window): () => void {
	const handler = (event: Event) => {
		const detail = (event as CustomEvent<CustomMcpDraft>).detail;
		if (detail && typeof detail.url === "string") onOpen(detail);
	};
	target.addEventListener(OPEN_CUSTOM_MCP_EVENT, handler);
	return () => target.removeEventListener(OPEN_CUSTOM_MCP_EVENT, handler);
}
