import { useSyncExternalStore } from "react";

/**
 * Decisão do dono num card do motor v4, guardada neste aparelho pela chave estável do card (`agentCardKey`):
 * recarregar a conversa mostra "Aprovado"/"Dispensado" em vez dos botões de novo. A fonte da verdade é o
 * servidor (a chamada resolvida chega como `tool_result` e marca o card como resolvido); isto só evita que o
 * card volte a pedir o que o dono já respondeu aqui. Só o estado: a resposta digitada não é guardada.
 */
export type AgentCardDecision = "approved" | "done" | "answered" | "dismissed";

const STORAGE_KEY = "atlas:agent-card-decisions";
/** Teto de entradas: as mais antigas saem primeiro (cards velhos não voltam a ser pendentes de qualquer jeito). */
export const AGENT_CARD_DECISIONS_MAX = 300;
const DECISIONS: ReadonlySet<string> = new Set<AgentCardDecision>(["approved", "done", "answered", "dismissed"]);

type Store = Array<[string, AgentCardDecision]>;

let cache: Map<string, AgentCardDecision> | null = null;
const listeners = new Set<() => void>();

function read(): Map<string, AgentCardDecision> {
	if (cache) return cache;
	const map = new Map<string, AgentCardDecision>();
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && DECISIONS.has(entry[1])) {
					map.set(entry[0], entry[1] as AgentCardDecision);
				}
			}
		}
	} catch {
		// storage indisponível (aba privada, bloqueado): fica só em memória
	}
	cache = map;
	return map;
}

export function getAgentCardDecision(key: string): AgentCardDecision | null {
	return read().get(key) ?? null;
}

export function setAgentCardDecision(key: string, decision: AgentCardDecision): void {
	const map = new Map(read());
	map.delete(key);
	map.set(key, decision);
	while (map.size > AGENT_CARD_DECISIONS_MAX) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	cache = map;
	try {
		const entries: Store = [...map.entries()];
		globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		// sem storage: a decisão vale até recarregar
	}
	for (const listener of listeners) listener();
}

/** Só para teste: esquece o que foi lido do storage. */
export function resetAgentCardDecisionsForTest(): void {
	cache = null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useAgentCardDecision(key: string): AgentCardDecision | null {
	return useSyncExternalStore(
		subscribe,
		() => getAgentCardDecision(key),
		() => null,
	);
}
