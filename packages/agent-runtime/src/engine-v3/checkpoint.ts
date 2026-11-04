import type { LlmMessage } from "@workspace/llm";
import { parseTaskList, parseToolUsageCounts, type TaskListItem } from "@workspace/shared";
import { completedToolCallIds } from "../checkpoint.js";
import { UNKNOWN_STATUS_NOTE } from "./failures.js";
import { NUDGE_CAPS, type NudgeKind, type NudgeState } from "./nudges.js";
import type { RepetitionSnapshot } from "./repetition.js";

/** Estado dos freios que vai no checkpoint (`engineV3`): a retomada não zera tetos de empurrão nem a rede de repetição. */
export type V3CheckpointState = {
	nudges: NudgeState;
	repetition: RepetitionSnapshot;
	ownTaskList?: TaskListItem[];
	/** Uso das tools congelado com o catálogo (o turno seguinte da conversa recebe pelo transcript). */
	toolUsage?: Record<string, number>;
	/** Pedidos recusados/pulados pelo dono neste trabalho (PR8a). */
	ownerRefused?: string[];
};

const pairs = (value: unknown): Array<[string, number]> =>
	Array.isArray(value)
		? value.filter((entry): entry is [string, number] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number").slice(-500)
		: [];

export function parseV3State(raw: Record<string, unknown> | undefined): Partial<V3CheckpointState> {
	if (!raw) return {};
	const nudges: NudgeState = {};
	const rawNudges = raw.nudges && typeof raw.nudges === "object" ? (raw.nudges as Record<string, unknown>) : {};
	for (const kind of Object.keys(NUDGE_CAPS) as NudgeKind[]) {
		const value = rawNudges[kind];
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) nudges[kind] = value;
	}
	const rep = raw.repetition && typeof raw.repetition === "object" ? (raw.repetition as Record<string, unknown>) : {};
	const repetition: RepetitionSnapshot = {
		blocks: typeof rep.blocks === "number" && rep.blocks >= 0 ? Math.floor(rep.blocks) : 0,
		counts: pairs(rep.counts),
		errors: pairs(rep.errors),
		history: Array.isArray(rep.history) ? rep.history.filter((key): key is string => typeof key === "string").slice(-12) : [],
	};
	const ownTaskList = parseTaskList(raw.ownTaskList);
	const toolUsage = parseToolUsageCounts(raw.toolUsage);
	const ownerRefused = Array.isArray(raw.ownerRefused) ? raw.ownerRefused.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 200).slice(-50) : [];
	return { nudges, repetition, ...(ownTaskList?.length ? { ownTaskList } : {}), ...(Object.keys(toolUsage).length > 0 ? { toolUsage } : {}), ...(ownerRefused.length > 0 ? { ownerRefused } : {}) };
}

/**
 * Retomada depois de crash/deploy (desenho 2.5): toda tool call do último passo que saiu e não tem resultado vira
 * "status desconhecido" no histórico, em vez de rodar de novo (o efeito pode já ter acontecido). Devolve os ids reparados.
 */
export function repairUnansweredCalls(conversation: LlmMessage[]): string[] {
	const lastAssistant = [...conversation].reverse().find((message) => message.role === "assistant");
	if (!lastAssistant?.tool_calls?.length) return [];
	const answered = completedToolCallIds(conversation);
	const pending = lastAssistant.tool_calls.filter((call) => !answered.has(call.id));
	for (const call of pending) conversation.push({ role: "tool", tool_call_id: call.id, content: UNKNOWN_STATUS_NOTE });
	return pending.map((call) => call.id);
}
