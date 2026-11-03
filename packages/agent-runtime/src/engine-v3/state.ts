import type { ChatTool, LlmMessage } from "@workspace/llm";
import type { AgentRunCheckpoint, BotLanguage, ComputerUseEvent, EffectiveAutonomy, TaskListItem } from "@workspace/shared";
import type { TokenUsage } from "../budget.js";
import type { McpToolEntry } from "../mcp/registry.js";
import type { createPreToolRunner } from "../hooks/pre-tool-runner.js";
import type { SecretSession } from "../secrets/session.js";
import type { ProviderHealth } from "../tools/provider-health.js";
import type { ComputerUseParams } from "../run-types.js";
import type { V3Catalog } from "./catalog.js";
import type { StepLimit } from "./limits.js";
import type { Nudges } from "./nudges.js";
import type { PolicyBase } from "./policy.js";
import type { RepetitionGuard } from "./repetition.js";

/** Estado do run v3 que os estados (PREPARE, MODEL_STEP, TOOLS, SETTLE) compartilham. Só em memória; o que retoma vai no checkpoint. */
export type V3Run = {
	params: ComputerUseParams;
	runId: string;
	userId: string;
	botId?: string;
	conversationId?: string;
	origin: string;
	/** Turno digitado por uma pessoa (o mesmo critério do v2); em subagente, o do pai. */
	humanTurn: boolean;
	/** Há quem aprove agora (política `canAsk`): só chat direto com turno humano. */
	canAsk: boolean;
	/** Origem sem ninguém para responder (rotina, webhook, proativo...): login vira nota, não cartão (como no v2). */
	unattended: boolean;
	/** Uma pessoa acompanha o run (chat com turno humano, inclusive resposta de cartão): sem o teto de 40 passos. */
	personWatching: boolean;
	language: BotLanguage;
	model: string;
	lastModel: string;
	turnId: string;
	/** Run cujo cartão este run continua (semente `transcriptSeed.fromRunId`): só aqui vale a decisão do dono sobre aquele cartão. */
	continuesRunId?: string;
	/** Núcleo + manifesto do run (congelado por conversa). */
	catalog: V3Catalog;
	/** Array enviado ao modelo: núcleo + `tool_search`/`tool_call`. */
	tools: ChatTool[];
	/** Uso das tools pelo bot (30 dias): desempate do `tool_search`. Vazio quando o catálogo veio congelado. */
	toolUsage: Readonly<Record<string, number>>;
	entryOf: (name: string) => McpToolEntry | undefined;
	hasTool: (name: string) => boolean;
	conversation: LlmMessage[];
	policy: PolicyBase;
	autonomy: { get: () => EffectiveAutonomy; set: (next: EffectiveAutonomy) => void };
	preTools: ReturnType<typeof createPreToolRunner>;
	secrets?: SecretSession;
	health: ProviderHealth;
	limit: StepLimit;
	step: number;
	usage: TokenUsage;
	estimatedCostUsd: number;
	spentUsd: () => number;
	activeMs: () => number;
	nudges: Nudges;
	repetition: RepetitionGuard;
	/** Última lista que o MODELO enviou por `update_task_list` neste run (lista herdada não conta para o E4). */
	ownTaskList?: TaskListItem[];
	taskListItems?: TaskListItem[];
	loginAsked: Set<string>;
	pendingLogin?: AgentRunCheckpoint["pendingLogin"];
	consumedInputIds: Set<string>;
	/** Mensagens do usuário que chegaram no meio do lote: entram na conversa depois dos resultados. */
	pendingSteer: Array<{ id: string; content: string; mode: string }>;
	toolCallCounts: Map<string, number>;
	mcpRun: { untrustedSeen: boolean; executed: string[]; conversationUntrusted: () => Promise<boolean> };
	markUntrusted: () => Promise<void>;
	shown: { images: number };
	emit: (event: ComputerUseEvent) => Promise<void>;
	persistCheckpoint: (stepIndex?: number) => Promise<void>;
	flushCheckpoints: () => Promise<void>;
};
