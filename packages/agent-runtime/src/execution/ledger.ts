import { parseLedgerEffects, parseLedgerResults } from "@workspace/shared";
import type {
	ExecutionLedgerCall,
	ExecutionLedgerDecision,
	ExecutionLedgerState,
} from "@workspace/shared";
import { contentHash, extractItemIds, shortKeyHash } from "./item-ids.js";
import { advanceStagnation } from "./stagnation.js";

/**
 * ExecutionLedger (K1, primeira fatia): por run, o que cada decisão leu e
 * quanto trouxe de novo. Pequeno por construção (tetos abaixo) e serializável
 * no checkpoint. Nenhuma regra de conector aqui: ids e hashes são genéricos.
 */
export const LEDGER_MAX_DECISIONS = 30;
export const LEDGER_MAX_CALLS_PER_DECISION = 6;
export const LEDGER_MAX_SEEN_IDS = 400;
export const LEDGER_MAX_SEEN_HASHES = 120;
/** Resultados menores que isto não valem uma referência: o aviso custaria o mesmo. */
export const MIN_REFERENCE_CHARS = 600;
/** Tools de meio (descoberta/releitura) não são evidência da tarefa. */
// `track_items` declara/atualiza a lista: não é conteúdo novo (o progresso dele é o item fechado).
const NON_EVIDENCE_TOOLS = new Set(["mcp_tool_search", "read_cached_result", "track_items"]);

export type ObserveInput = {
	step: number;
	tool: string;
	/** Chave normalizada dos args (sem texto livre). */
	argKey: string;
	/** Texto devolvido pela tool (antes de qualquer substituição). */
	resultText: string;
	ok: boolean;
	/** `result_ref` durável desta chamada, se houver. */
	ref?: string;
	/** Efeito concluído (escrita MCP ok, arquivo, rotina...). */
	wrote?: boolean;
	/** Resposta veio do cache de leitura: hash do original em vez do aviso. */
	reuseOfRef?: string;
};

export type Observation = {
	hash: string;
	newIds: number;
	/** Resultado idêntico a um anterior do run (mesmo com args diferentes). */
	identicalTo?: { tool: string; step: number; ref?: string };
};

export type ExecutionLedger = ReturnType<typeof createExecutionLedger>;

const EMPTY: ExecutionLedgerState = {
	v: 1,
	decisions: [],
	seenIds: [],
	seenHashes: [],
	streak: 0,
	nudged: 0,
	closedStep: -1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: fallback;
}

/** Valida o JSON vindo do checkpoint; qualquer coisa estranha vira ledger vazio. */
export function parseLedgerState(raw: unknown): ExecutionLedgerState {
	if (!isRecord(raw) || raw.v !== 1) return structuredClone(EMPTY);
	const strings = (value: unknown, max: number): string[] =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string").slice(-max)
			: [];
	const decisions: ExecutionLedgerDecision[] = [];
	for (const item of Array.isArray(raw.decisions) ? raw.decisions : []) {
		if (!isRecord(item) || !Array.isArray(item.calls)) continue;
		const calls: ExecutionLedgerCall[] = [];
		for (const call of item.calls) {
			if (!isRecord(call) || typeof call.tool !== "string") continue;
			calls.push({
				tool: call.tool.slice(0, 120),
				argKey: typeof call.argKey === "string" ? call.argKey.slice(0, 24) : "",
				hash: typeof call.hash === "string" ? call.hash.slice(0, 24) : "",
				ok: call.ok === true,
				ids: finite(call.ids, 0),
				...(typeof call.ref === "string" ? { ref: call.ref.slice(0, 200) } : {}),
			});
		}
		decisions.push({
			step: finite(item.step, 0),
			novelty: finite(item.novelty, 0),
			calls: calls.slice(0, LEDGER_MAX_CALLS_PER_DECISION),
		});
	}
	const seenHashes: ExecutionLedgerState["seenHashes"] = [];
	for (const item of Array.isArray(raw.seenHashes) ? raw.seenHashes : []) {
		if (!isRecord(item) || typeof item.hash !== "string") continue;
		seenHashes.push({
			hash: item.hash.slice(0, 24),
			tool: typeof item.tool === "string" ? item.tool.slice(0, 120) : "tool",
			step: finite(item.step, 0),
			...(typeof item.ref === "string" ? { ref: item.ref.slice(0, 200) } : {}),
		});
	}
	return {
		v: 1,
		decisions: decisions.slice(-LEDGER_MAX_DECISIONS),
		seenIds: strings(raw.seenIds, LEDGER_MAX_SEEN_IDS),
		seenHashes: seenHashes.slice(-LEDGER_MAX_SEEN_HASHES),
		streak: finite(raw.streak, 0),
		nudged: raw.nudged === 1 || raw.nudged === 2 ? raw.nudged : 0,
		closedStep: typeof raw.closedStep === "number" ? Math.floor(raw.closedStep) : -1,
		// Journal de efeitos e status estruturado (F2b): ausentes em checkpoint antigo.
		...(Array.isArray(raw.effects) ? { effects: parseLedgerEffects(raw.effects) } : {}),
		...(isRecord(raw.results) ? { results: parseLedgerResults(raw.results) } : {}),
	};
}

export function createExecutionLedger(initial?: unknown) {
	const state = parseLedgerState(initial);
	const seenIds = new Set(state.seenIds);

	const decisionFor = (step: number): ExecutionLedgerDecision => {
		const existing = state.decisions.find((item) => item.step === step);
		if (existing) return existing;
		const created: ExecutionLedgerDecision = { step, novelty: 0, calls: [] };
		state.decisions.push(created);
		if (state.decisions.length > LEDGER_MAX_DECISIONS) state.decisions.shift();
		return created;
	};

	return {
		/** Registra uma chamada; devolve o hash e se o conteúdo já apareceu no run. */
		observe(input: ObserveInput): Observation {
			const decision = decisionFor(input.step);
			const reused = input.reuseOfRef
				? state.seenHashes.find((item) => item.ref === input.reuseOfRef)
				: undefined;
			const hash = reused?.hash ?? contentHash(input.resultText);
			const ids = input.ok && !reused ? extractItemIds(input.resultText) : [];
			const known = state.seenHashes.find((item) => item.hash === hash);
			const evidence = input.ok && !NON_EVIDENCE_TOOLS.has(input.tool);
			let newIds = 0;
			for (const id of ids) {
				if (seenIds.has(id)) continue;
				seenIds.add(id);
				state.seenIds.push(id);
				newIds += 1;
			}
			while (state.seenIds.length > LEDGER_MAX_SEEN_IDS) {
				seenIds.delete(state.seenIds.shift()!);
			}
			// Com ids, a novidade são os itens novos (a mesma lista reprojetada
			// não conta); sem ids (texto livre, página), conteúdo novo conta.
			let novelty = 0;
			if (evidence) {
				if (ids.length > 0) novelty += newIds;
				else if (!known) novelty += 1;
				if (input.wrote) novelty += 1;
			}
			if (!known && input.ok && !reused) {
				state.seenHashes.push({
					hash,
					tool: input.tool,
					step: input.step,
					...(input.ref ? { ref: input.ref } : {}),
				});
				if (state.seenHashes.length > LEDGER_MAX_SEEN_HASHES) state.seenHashes.shift();
			}
			decision.novelty += novelty;
			if (decision.calls.length < LEDGER_MAX_CALLS_PER_DECISION) {
				decision.calls.push({
					tool: input.tool.slice(0, 120),
					argKey: shortKeyHash(input.argKey),
					hash,
					ok: input.ok,
					ids: ids.length,
					...(input.ref ? { ref: input.ref } : {}),
				});
			}
			return {
				hash,
				newIds,
				...(known && input.ok
					? {
							identicalTo: {
								tool: known.tool,
								step: known.step,
								...(known.ref ? { ref: known.ref } : {}),
							},
						}
					: {}),
			};
		},

		/** Fecha a decisão: atualiza a sequência sem novidade e devolve o aviso, se for a hora. */
		endDecision(step: number): { novelty: number; nudge: string | null } {
			const decision = decisionFor(step);
			if (step <= state.closedStep) return { novelty: decision.novelty, nudge: null };
			state.closedStep = step;
			if (decision.calls.length === 0) return { novelty: 0, nudge: null };
			const next = advanceStagnation(
				{ streak: state.streak, nudged: state.nudged },
				decision.novelty,
			);
			state.streak = next.state.streak;
			state.nudged = next.state.nudged;
			return { novelty: decision.novelty, nudge: next.message };
		},

		/** Chave estável das chamadas da decisão (tool + args normalizados), para detectar a mesma ação repetida. */
		actionKey(step: number): string {
			const decision = state.decisions.find((item) => item.step === step);
			return decision ? decision.calls.map((entry) => `${entry.tool}:${entry.argKey}`).join("|") : "";
		},

		/** Novidade acumulada desde a decisão `step` (inclusive). */
		noveltySince(step: number): number {
			return state.decisions
				.filter((item) => item.step >= step)
				.reduce((sum, item) => sum + item.novelty, 0);
		},

		/** Novidade das últimas `count` decisões (janela recente, não o run todo). */
		noveltyInLast(count: number): number {
			return state.decisions.slice(-count).reduce((sum, item) => sum + item.novelty, 0);
		},

		/** Sequência atual sem novidade e quantos avisos já saíram. */
		stagnation(): { streak: number; nudged: number } {
			return { streak: state.streak, nudged: state.nudged };
		},

		snapshot(): ExecutionLedgerState {
			return structuredClone({
				...state,
				seenIds: [...state.seenIds],
			});
		},
	};
}

/** Aviso que substitui um payload repetido (voltado ao modelo, neutro). */
export function identicalResultNotice(
	identical: NonNullable<Observation["identicalTo"]>,
): string {
	const where = `${identical.tool} at step ${identical.step + 1}`;
	const ref = identical.ref ? ` (result_ref: ${identical.ref})` : "";
	return `Identical to the result of ${where}${ref}; reuse it. Call read_cached_result with that result_ref only if you need the details again.`;
}
