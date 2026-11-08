// Tradução dos eventos do kernel para o contrato SSE que o web e o celular JÁ renderizam (`ComputerUseEvent`
// em `packages/shared`). O contrato externo não muda (03 §9): tudo que tem equivalente vira o tipo antigo;
// o que não tem vira tipo NOVO e tipado em `shared/src/agent-v4-events.ts` (cliente antigo ignora).
//
//   kernel            →  ComputerUseEvent
//   step              →  (nada; só dá o id do balão do passo)
//   text_delta        →  assistant_delta   id = `<run>-step-<n>` (`<run>-final` no passo final)
//   retract           →  assistant_discard reason "duplicate" (some da tela; ver abaixo)
//   tool_call         →  tool_call         args em JSON texto, `step`
//   tool_result       →  tool_result       ok = ok | already_done | handoff_done
//   receipt           →  receipt           NOVO
//   card approval     →  approval_request  NOVO
//   card handoff      →  handoff_request   NOVO
//   card ask_owner    →  ask_owner         NOVO
//   status compacted  →  context_compacted (antes → depois, em tokens)
//   status cancelled  →  cancelled
//   status kernel_error → error (texto amigável; o detalhe técnico não vai ao dono)
//   status <outro>    →  status {status: motivo, detail: mensagem}
//   final done/not_done → [status budget_exhausted se foi teto,] done {message, model, usage?, stopReason}
//   final failed      →  error (texto amigável)
//
// Retry de transporte (erro no meio do stream): o kernel emite `retract` antes de refazer o passo e este
// mapa o transforma em `assistant_discard` com motivo `duplicate`, o único que APAGA o balão (os outros
// motivos o deixam como rascunho revisado). O mesmo id de balão recebe o texto da nova tentativa. A escolha
// evita buffer (o streaming ao vivo continua) e reaproveita o evento que o web, o celular e o gravador de
// segmentos do worker já tratam: `assistant-segments` descarta o passo sem gravar rascunho.
//
// Run estacionado (aprovação/handoff) não emite `final` no kernel: o fim do stream nesse caso é do worker
// (status do run `parked`). Texto que o dono lê vem de `copy` no idioma do bot, nunca de mensagem interna.
import { type ComputerUseEvent, type RunStopReason, type RunUsage, redactSecrets } from "@workspace/shared";
import { copyFor } from "../copy/index.js";
import type { RunEvent } from "../ports/events.js";
import type { KernelEvent } from "./types.js";

export const KERNEL_EVENT_TYPES = ["step", "text_delta", "retract", "tool_call", "tool_result", "receipt", "card", "status", "final"] as const satisfies readonly KernelEvent["type"][];
// Falha de tipo se um tipo novo de evento entrar no kernel sem entrar na lista (e, portanto, sem mapeamento).
type MissingKernelEventType = Exclude<KernelEvent["type"], (typeof KERNEL_EVENT_TYPES)[number]>;
const _allKernelEventsListed: [MissingKernelEventType] extends [never] ? true : never = true;
void _allKernelEventsListed;

export type SseMapOptions = {
	runId: string;
	/** Modelo que responde (aparece no `done`). */
	model: string;
	/** Idioma do bot, para os textos ao dono gerados aqui. */
	language?: unknown;
	/** Teto de passos a mostrar em `tool_call.maxSteps` (opcional). */
	maxSteps?: number;
	/** Uso acumulado do run, quando o worker o tem; vai no `done`. */
	usage?: () => RunUsage | undefined;
	/** Valores do cofre usados no run (`trackVault`): os argumentos de `tool_call` saem sem eles. */
	secrets?: () => readonly string[];
	/** Passo em que o run está (do checkpoint) ao RETOMAR; sem valor começa em 0. O evento `tool_call` do kernel também traz o passo. */
	step?: number;
};

export type SseMapper = {
	map(event: KernelEvent): ComputerUseEvent[];
	/** Para o que sai da porta `Events`: tipo desconhecido vira lista vazia (nunca lança). */
	mapRunEvent(event: RunEvent): ComputerUseEvent[];
};

const KERNEL_TYPES: ReadonlySet<string> = new Set(KERNEL_EVENT_TYPES);
const OK_STATUSES: ReadonlySet<string> = new Set(["ok", "already_done", "handoff_done"]);

/** `RunResult.stop.kind` → vocabulário fechado de `RUN_STOP_REASONS`. */
export function stopReasonOf(final: Extract<KernelEvent, { type: "final" }>["data"]): RunStopReason {
	if (final.status === "failed") return final.reason === "cancelled" ? "cancelled" : "error";
	switch (final.stop?.kind) {
		case "steps_owner":
		case "steps_unattended":
		case "steps_safety":
			return "budget_steps";
		case "cost":
			return "budget_cost";
		case "repeated":
			return "loop_repeat";
	}
	if (final.reason === "truncated") return "truncated";
	if (final.status === "not_done") return "tool_failures";
	return "answered";
}

/** Teto do `summary` no SSE. SÓ exibição: o conteúdo inteiro segue no contexto do modelo e no caderno; o corte aqui não muda o que o modelo vê. */
export const TOOL_RESULT_DISPLAY_CHARS = 2000;
const displaySummary = (content: string): string => (content.length > TOOL_RESULT_DISPLAY_CHARS ? `${content.slice(0, TOOL_RESULT_DISPLAY_CHARS)}…` : content);

function argsText(args: unknown, secrets: readonly string[] = []): string {
	try {
		return redactSecrets(JSON.stringify(args ?? {}) ?? "{}", secrets);
	} catch {
		return "{}";
	}
}

export function createSseMapper(options: SseMapOptions): SseMapper {
	let step = options.step ?? 0;
	let finalStep = false;
	const bubbleId = () => (finalStep ? `${options.runId}-final` : `${options.runId}-step-${step}`);
	const withRun = { runId: options.runId };

	function map(event: KernelEvent): ComputerUseEvent[] {
		switch (event.type) {
			case "step":
				step = event.data.step;
				finalStep = event.data.final;
				return [];
			case "text_delta":
				return [{ type: "assistant_delta", id: bubbleId(), delta: event.data.text }];
			case "retract":
				return [{ type: "assistant_discard", id: bubbleId(), reason: "duplicate" }];
			case "tool_call":
				return [{ type: "tool_call", id: event.data.callId, name: event.data.name, args: argsText(event.data.args, options.secrets?.()), step: event.data.step ?? step, ...(options.maxSteps !== undefined && { maxSteps: options.maxSteps }) }];
			case "tool_result":
				return [{ type: "tool_result", id: event.data.callId, name: event.data.name, ok: OK_STATUSES.has(event.data.status), summary: displaySummary(event.data.content) }];
			case "receipt": {
				const { callId, name, what, where, externalId, url } = event.data;
				return [{ type: "receipt", id: callId, name, what, ...(where && { where }), ...(externalId && { externalId }), ...(url && { url }), ...withRun }];
			}
			case "card": {
				const card = event.data;
				if (card.kind === "approval") {
					const { id, toolName, effect, args, riskFacts, ownerInput, inputOnly } = card.request;
					return [{ type: "approval_request", requestId: id, callId: card.callId, toolName, effect, args, riskFacts: { ...riskFacts }, ...(ownerInput && { ownerInput }), ...(inputOnly && { inputOnly }), ...withRun }];
				}
				if (card.kind === "handoff") return [{ type: "handoff_request", callId: card.callId, message: card.userMessage, ...withRun }];
				return [{ type: "ask_owner", cardId: card.cardId, question: card.question, ...(card.offer && { offer: card.offer }), ...withRun }];
			}
			case "status": {
				const { reason, message, before, after } = event.data;
				if (reason === "compacted" && before !== undefined && after !== undefined) return [{ type: "context_compacted", before, after }];
				if (reason === "cancelled") return [{ type: "cancelled", reason: "cancelled", stopReason: "cancelled" }];
				if (reason === "kernel_error") return [{ type: "error", error: copyFor(options.language, "run_failed"), stopReason: "error" }];
				return [{ type: "status", status: reason, detail: message }];
			}
			case "final": {
				const data = event.data;
				const stopReason = stopReasonOf(data);
				if (data.status === "parked") return [];
				if (data.status === "failed") return [{ type: "error", error: copyFor(options.language, data.reason === "model_error" ? "run_failed_model" : "run_failed"), stopReason }];
				const out: ComputerUseEvent[] = [];
				if (stopReason === "budget_steps" || stopReason === "budget_cost") {
					out.push({ type: "status", status: "budget_exhausted", detail: copyFor(options.language, stopReason), stopReason });
				}
				const usage = options.usage?.();
				out.push({ type: "done", message: { role: "assistant", content: data.text }, model: options.model, ...(usage && { usage }), stopReason });
				return out;
			}
		}
	}

	return {
		map,
		mapRunEvent(event) {
			if (!KERNEL_TYPES.has(event.type) || typeof event.data !== "object" || event.data === null) return [];
			return map({ type: event.type, data: event.data } as KernelEvent);
		},
	};
}
