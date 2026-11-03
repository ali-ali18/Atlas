import type { ComputerUseEvent } from "./computer.js";

/**
 * Contrato dos eventos SSE de run (web, mobile e desktop leem o mesmo fluxo).
 * Regras: tipo novo só entra de forma aditiva e NUNCA é terminal; cliente antigo ignora o tipo que não conhece.
 * A checagem de exaustividade abaixo faz o `tsc` falhar se `ComputerUseEvent` ganhar ou perder um tipo
 * sem esta lista acompanhar.
 */
export const RUN_EVENT_TYPES = [
	"provider_fallback",
	"images",
	"run",
	"assistant_delta",
	"assistant_discard",
	"agent_pointer",
	"dev_session_status",
	"dev_setup_step",
	"shell_started",
	"shell_output",
	"shell_done",
	"file_edit",
	"todo_updated",
	"dev_environment_updated",
	"dev_pr",
	"dev_ci",
	"context_compacted",
	"context_usage",
	"dev_timing",
	"session",
	"tool_intent",
	"tool_call",
	"tool_result",
	"tool_budget_extended",
	"subagent_started",
	"subagent_tool",
	"subagent_done",
	"done",
	"paused",
	"cancelled",
	"input_consumed",
	"input_received",
	"status",
	"error",
	"skill",
	"skill-proposal",
	"bot-proposal",
	"routine",
	"task_list",
	"chart",
	"page",
	"file",
	"login",
	"confirm",
	"questionnaire",
	"bot-profile",
] as const satisfies readonly ComputerUseEvent["type"][];

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** Falha de compilação se o union ganhar um tipo que a lista não tem. */
type MissingFromList = Exclude<ComputerUseEvent["type"], RunEventType>;
const _listaCompleta: [MissingFromList] extends [never] ? true : MissingFromList = true;
void _listaCompleta;

/**
 * Os 5 fins de run de hoje. `status` só termina com `status: "budget_exhausted"`; os demais
 * `status` (ex.: `running`) são informativos.
 */
export const RUN_TERMINAL_EVENTS = ["done", "paused", "cancelled", "error", "status:budget_exhausted"] as const;

export type RunTerminalEvent = (typeof RUN_TERMINAL_EVENTS)[number];

/** Chave terminal do evento (`done`, `status:budget_exhausted`…) ou `null` se o evento não encerra o run. */
export function runTerminalKey(event: ComputerUseEvent): RunTerminalEvent | null {
	if (event.type === "done" || event.type === "paused" || event.type === "cancelled" || event.type === "error") return event.type;
	if (event.type === "status" && event.status === "budget_exhausted") return "status:budget_exhausted";
	return null;
}
