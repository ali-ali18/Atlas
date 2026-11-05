// Tipos do kernel: entrada do run, limites, estado serializável (checkpoint) e eventos tipados.
// O estado inteiro cabe em JSON: é o que `Store.runs.saveCheckpoint` guarda e `runAgent` restaura.
import type { CapabilityRegistry } from "../capabilities/index.js";
import type { ChannelInput } from "../channels/index.js";
import type { ApprovalGrant, ApprovalRequest, Hash, PolicyContext, ProvenanceSnapshot } from "../contract/index.js";
import type { LlmMessage, Ports } from "../ports/index.js";
import type { RunCheckpoint } from "../ports/store.js";
import type { GuardState } from "./loop-guard.js";

export type KernelState = RunCheckpoint["state"];

/** Só o que protege o dono. Não existe teto de tempo nem de pesquisa (ADR 0003). */
export type RunLimits = {
	/** Teto de passos que o dono configurou (conta, bot ou pedido). */
	ownerMaxSteps?: number;
	/** Teto de gasto (US$) que o dono configurou. */
	ownerMaxUsd?: number;
	/** Sem dono olhando (rotina, webhook, proativo): vale o teto de segurança menor. */
	unattended?: boolean;
	/** Padrão 40, só sem dono presente e sem `ownerMaxSteps`. */
	unattendedMaxSteps?: number;
	/** Rede de segurança contra laço, padrão 200. */
	safetyMaxSteps?: number;
};

/** Ajustes técnicos (não são limites de gasto). */
export type KernelOptions = {
	/** Fração da janela do papel `main` em que a compactação dispara. Padrão 0.85. */
	compactAtRatio?: number;
	/** Tamanho (caracteres) de uma página de saída de tool. Padrão 24000. */
	pageChars?: number;
	/** Mensagens recentes mantidas fora do resumo. Padrão 6. */
	keepRecent?: number;
};

/** O que o dono fez ao retomar um run estacionado. */
export type ResumeInput = {
	grants?: readonly ApprovalGrant[];
	/** Ids de pedido (ApprovalRequest.id) que o dono recusou. */
	denied?: readonly string[];
	/** Ids de chamada cujo passo de handoff o dono assumiu. */
	handoffDone?: readonly string[];
};

export type RunInput = {
	/** Bloco 1 (igual em todo run). */
	stableSystem: string;
	/** Seções do bloco 2 (`[context]`). */
	contextSections: readonly string[];
	/** Histórico normal da conversa. O kernel NUNCA injeta estado de tarefa de outro run. */
	history: readonly ChannelInput[];
	resume?: ResumeInput;
};

export type RunAgentDeps = {
	runId: string;
	ownerId: string;
	input: RunInput;
	ports: Ports;
	registry: CapabilityRegistry;
	policy: PolicyContext;
	limits: RunLimits;
	hash: Hash;
	options?: KernelOptions;
	signal?: AbortSignal;
};

export type PendingCall = { id: string; name: string; args: unknown };

export type ParkedCall = { kind: "approval" | "handoff"; requestId?: string };

export type KernelSnapshot = {
	v: 1;
	nonce: string;
	messages: LlmMessage[];
	step: number;
	loadedIds: string[];
	provenance: ProvenanceSnapshot;
	spentUsd: number;
	stepsWithoutPrice: number;
	/** Posições em `messages` das falas do dono (para listá-las por inteiro ao compactar). */
	ownerIdx: number[];
	/** O que a compactação já mandou para o caderno de trabalho. */
	compacted: { noteIds: string[]; ownerTexts: string[] };
	compactions: number;
	/** Chamadas do passo atual. */
	pending: PendingCall[];
	/** Conteúdo já produzido por chamada (efeito já gravado no journal). */
	results: Record<string, string>;
	parked: Record<string, ParkedCall>;
	guard: GuardState;
	/** Último erro por tool que ainda não foi seguido de sucesso. */
	lastErrors: Record<string, string>;
	/** Chamadas malformadas no passo atual e passos seguidos com alguma. */
	malformedNow: number;
	malformedStreak: number;
	lastInputTokens: number;
	/** Índice em `messages` até onde `lastInputTokens` vale. */
	tokensAtCount: number;
	/** Motivo do passo final (limite ou laço). */
	stop?: { kind: string; label: string };
	/** Resultado final, quando DONE. */
	result?: RunResult;
};

export type RunResult = {
	status: "done" | "not_done" | "parked" | "failed";
	text: string;
	steps: number;
	spentUsd: number;
	stop?: { kind: string; label: string };
	/** Tools cujo último resultado foi erro e foi relatado: terminam como `not_done`, sem retomada sozinha. */
	unresolved: Record<string, string>;
	/** Motivo real quando o run acabou por falha de transporte ou resposta vazia. */
	reason?: string;
	/** Chamadas estacionadas (cartões abertos). */
	parked?: Record<string, ParkedCall>;
	/** Cartão de pergunta ao dono que encerrou o turno (F1.9). */
	awaiting?: string;
};

export type KernelEvent =
	| { type: "step"; data: { step: number; final: boolean } }
	| { type: "text_delta"; data: { text: string } }
	| { type: "tool_call"; data: { callId: string; name: string; args: unknown } }
	| { type: "tool_result"; data: { callId: string; name: string; status: string; content: string } }
	| { type: "card"; data: { kind: "approval"; callId: string; request: ApprovalRequest } | { kind: "handoff"; callId: string; userMessage: string } | { kind: "ask_owner"; cardId: string; question: string; offer?: string } }
	| { type: "status"; data: { reason: string; message: string } }
	| { type: "final"; data: { text: string; status: RunResult["status"]; steps: number; spentUsd: number; stop?: { kind: string; label: string } } };
