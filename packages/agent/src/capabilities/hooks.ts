// Ganchos tipados das capacidades. REGRA: nenhum gancho toca o texto do assistente. Por tipo,
// nenhum recebe esse texto (só nome, args e resultado da tool) e nenhum pode devolvê-lo
// (as chaves de texto são `never`). O que um gancho pode fazer é só o que está aqui.
import type { Effect } from "../contract/effects.js";
import type { RiskFacts, ToolContext, ToolResult } from "../tools/types.js";

/** Chaves que um gancho nunca pode devolver: seriam texto do assistente. */
type NoAssistantText = { text?: never; assistantText?: never; content?: never; message?: never; reply?: never };

export type ToolCallInfo = { name: string; args: unknown; effect: Effect };

/** Pedido de agenda feito por um gancho. Forma provisória: a F4 define a entidade da agenda. */
export type AgendaItemSpec = {
	kind: "remind" | "watch" | "intent" | "brief";
	objective: string;
	/** ISO 8601. */
	runAt?: string;
	everyMinutes?: number;
};

export type BeforeToolOutcome = { verdict?: "ask" | "deny"; riskFacts?: RiskFacts } & NoAssistantText;
export type AfterToolOutcome = { schedule?: AgendaItemSpec[]; note?: string } & NoAssistantText;

export type RunEndInfo = {
	runId: string;
	outcome: "final" | "parked" | "failed";
	toolCalls: readonly { name: string; ok: boolean }[];
};

/** Trabalho para depois do run (ex.: o sono). Forma provisória. */
export type JobSpec = { kind: string; payload?: Readonly<Record<string, unknown>> };

export type WakeItem = AgendaItemSpec & { id: string };

type Maybe<T> = T | void | Promise<T | void>;

export type BeforeToolHook = (call: ToolCallInfo, ctx: ToolContext) => Maybe<BeforeToolOutcome>;
/** `note` entra no resultado da tool (nunca na fala do assistente). */
export type AfterToolHook = (call: ToolCallInfo, result: ToolResult, ctx: ToolContext) => Maybe<AfterToolOutcome>;
export type OnRunEndHook = (run: RunEndInfo) => Maybe<JobSpec[]>;
/** Devolve o objetivo do run de despertar. */
export type OnWakeHook = (item: WakeItem) => Maybe<string>;

export type CapabilityHooks = {
	/** Por nome de tool da própria capacidade. */
	beforeTool?: Readonly<Record<string, BeforeToolHook>>;
	afterTool?: Readonly<Record<string, AfterToolHook>>;
	onRunEnd?: OnRunEndHook;
	onWake?: OnWakeHook;
};
