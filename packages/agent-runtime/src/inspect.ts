import type { LlmMessage } from "@workspace/llm";
import { scrubValue, type InspectAction, type InspectCategory, type StepInspect } from "@workspace/shared";
import { estimateMessagesTokens, type HygieneReport } from "./hygiene.js";
import { toolsJsonCharsOf } from "./tools-json-size.js";

/**
 * Inspetor do run: por chamada ao modelo, um resumo compacto do que foi enviado (tokens estimados por
 * categoria, tools disponíveis, ações de higiene). Vai em `outputJson.inspect` do passo do modelo, sem
 * armazenamento novo. O texto do pedido só entra com `ATLAS_RUN_INSPECTOR_FULL=1`, redigido e limitado.
 */
export const INSPECT_FULL_ENV = "ATLAS_RUN_INSPECTOR_FULL";
/** Teto do pedido serializado por passo e por run (caracteres). */
export const INSPECT_REQUEST_STEP_MAX = 60_000;
export const INSPECT_REQUEST_RUN_MAX = 1_500_000;
export const INSPECT_MESSAGE_TEXT_MAX = 4_000;
export const INSPECT_TOOL_NAMES_MAX = 400;

export function inspectFullEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env[INSPECT_FULL_ENV] === "1";
}

type ToolLike = { function: { name: string } };

/**
 * Categoria de cada mensagem: a 1ª de sistema é o prompt/instruções; as demais de sistema são notas
 * injetadas (memória, avisos, guias); resultados de tool; depois da última fala do usuário é o turno
 * atual; o resto é histórico.
 */
export function categorizeMessages(messages: readonly LlmMessage[]): Record<Exclude<InspectCategory, "tools">, number> {
	const out = { system: 0, history: 0, toolResults: 0, notes: 0, turn: 0 };
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (message.role === "user") lastUser = index;
	});
	let firstSystemSeen = false;
	messages.forEach((message, index) => {
		const tokens = estimateMessagesTokens([message]);
		if (message.role === "system") {
			if (!firstSystemSeen) {
				firstSystemSeen = true;
				out.system += tokens;
			} else out.notes += tokens;
		} else if (message.role === "tool") out.toolResults += tokens;
		else if (index >= lastUser && lastUser >= 0) out.turn += tokens;
		else out.history += tokens;
	});
	return out;
}

function serializeRequest(messages: readonly LlmMessage[], toolNames: readonly string[], budget: number): { text: string; truncated: boolean } {
	const rows: unknown[] = [];
	let size = 0;
	let truncated = false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		const content = typeof message.content === "string" ? message.content : message.content === null ? null : JSON.stringify(message.content);
		const row = {
			role: message.role,
			...(content !== null ? { content: content.length > INSPECT_MESSAGE_TEXT_MAX ? `${content.slice(0, INSPECT_MESSAGE_TEXT_MAX)}…` : content } : {}),
			...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => ({ name: call.function.name, arguments: call.function.arguments.slice(0, 1_000) })) } : {}),
			...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
		};
		const length = JSON.stringify(row).length;
		if (size + length > budget) {
			truncated = true;
			break;
		}
		size += length;
		rows.unshift(row);
	}
	// scrubValue mascara chaves sensíveis e padrões de token em cada string (mesmo filtro do Sentry).
	return { text: JSON.stringify(scrubValue({ tools: toolNames, messages: rows })), truncated };
}

export function createStepInspector(options: { full?: boolean } = {}) {
	const full = options.full ?? inspectFullEnabled();
	let pending: InspectAction[] = [];
	let previousTools: string[] | undefined;
	let requestChars = 0;

	return {
		/** Ação aplicada antes da próxima chamada (resumo, compactação). */
		noteAction(action: InspectAction): void {
			if (pending.length < 12) pending.push(action);
		},
		/** Relatório da higiene do passo: vira ações (só o que realmente mudou). */
		noteHygiene(report: HygieneReport): void {
			if (report.collapsedGroups > 0) this.noteAction({ kind: "collapsed", count: report.collapsedGroups });
			if (report.trimmedMessages > 0) this.noteAction({ kind: "trimmed", count: report.trimmedMessages, before: report.estimatedTokensBefore, after: report.estimatedTokensAfter });
			if (report.guard !== "none") this.noteAction({ kind: "guard", detail: report.guard });
			if (report.compaction) this.noteAction({ kind: "compaction", before: report.compaction.before, after: report.compaction.after });
		},
		/** Descreve a chamada que vai sair. Consome as ações pendentes. */
		step(input: { messages: readonly LlmMessage[]; tools: readonly ToolLike[]; contextLength?: number }): StepInspect {
			const names = input.tools.map((tool) => tool.function.name);
			const split = categorizeMessages(input.messages);
			const toolTokens = estimateMessagesTokens([], toolsJsonCharsOf(input.tools));
			const tokens: Record<InspectCategory, number> = { ...split, tools: toolTokens };
			const total = Object.values(tokens).reduce((sum, value) => sum + value, 0);
			let tools: StepInspect["tools"];
			if (!previousTools) tools = { count: names.length, names: names.slice(0, INSPECT_TOOL_NAMES_MAX) };
			else {
				const before = new Set(previousTools);
				const now = new Set(names);
				const added = names.filter((name) => !before.has(name));
				const removed = previousTools.filter((name) => !now.has(name));
				tools = { count: names.length, ...(added.length ? { added: added.slice(0, INSPECT_TOOL_NAMES_MAX) } : {}), ...(removed.length ? { removed: removed.slice(0, INSPECT_TOOL_NAMES_MAX) } : {}) };
			}
			previousTools = names.slice(0, INSPECT_TOOL_NAMES_MAX);
			const actions = pending;
			pending = [];
			let request: StepInspect["request"];
			if (full && requestChars < INSPECT_REQUEST_RUN_MAX) {
				const serialized = serializeRequest(input.messages, names, Math.min(INSPECT_REQUEST_STEP_MAX, INSPECT_REQUEST_RUN_MAX - requestChars));
				requestChars += serialized.text.length;
				request = { text: serialized.text, ...(serialized.truncated ? { truncated: true } : {}) };
			}
			return {
				v: 1,
				tokens,
				total,
				messages: input.messages.length,
				...(input.contextLength ? { contextLength: input.contextLength } : {}),
				tools,
				actions,
				...(request ? { request } : {}),
			};
		},
	};
}
