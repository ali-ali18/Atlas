import { TOKEN_ESTIMATE_CHARS_PER_TOKEN, estimateTokens } from "@workspace/shared";
import type { LlmContentPart, LlmMessage } from "@workspace/llm";
import type { TaskState } from "@workspace/shared";
import { BudgetExhaustedError } from "./errors.js";
import { extractResultRef, stripResultRef } from "./context/result-store.js";
import { compactToBudget, type CodingNoteContext, type ContextBudget } from "./context/budget.js";

/**
 * Higiene de prompt — Fase 0 (sem LLM novo, sem migração).
 *
 * Ponto único: roda sobre a conversa JÁ MONTADA no runtime (fresh e resume),
 * porque o resume de checkpoint (`hydrateLlmMessages`) ignora o
 * `prepareMessages` do worker. Colapsa tool-results antigos + apara por
 * janela do modelo. Nunca toca no banco: o transcript completo continua
 * intacto, só o pacote enviado ao LLM emagrece.
 */
export const HYGIENE_SOFT_RATIO = 0.5;
export const HYGIENE_HARD_RATIO = 0.85;
export const HYGIENE_SOFT_KEEP = 16;
export const HYGIENE_HARD_KEEP = 4;
export const DEFAULT_CONTEXT_LENGTH = 128_000;
export const MAX_BINARY_CHARS = 20_000;

export const COLLAPSE_MARKER =
	"[higiene: resultados de ferramentas anteriores colapsados";

/** Conversa contínua: grupos de resultados de ferramenta mais recentes que a limpeza nunca toca. */
export const RECENT_TOOL_GROUPS_KEPT = 6;
/** Conversa contínua: fração do teto do orçamento de contexto a partir da qual resultados antigos começam a ser limpos. */
export const COLLAPSE_PRESSURE_RATIO = 0.6;

export const STUB_TOOL_OUTPUT_MAX_CHARS = 8000;
/** Teto do grupo de tools mais recente: o modelo ainda não leu esse resultado. */
export const STUB_LAST_GROUP_MAX_CHARS = 24_000;
export const STUB_TRUNCATED_MARKER = "[truncado:";


export type HygieneReport = {
	contextLength: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	collapsedGroups: number;
	trimmedMessages: number;
	guard: "none" | "soft" | "hard";
	/** Houve compactação por orçamento neste passo (estimativas de tokens antes/depois). */
	compaction?: { before: number; after: number };
};

function textLength(message: LlmMessage): number {
	if (typeof message.content === "string") return message.content.length;
	if (message.content === null) return 0;
	const imageCount = message.content.filter((part) => part.type === "image_url" || part.type === "screenshot_ref" || part.type === "image_ref").length;
	return Math.min(JSON.stringify(message.content).length, MAX_BINARY_CHARS) + imageCount * 6_000;
}

/** Soma caracteres de texto + tool_calls (JSON das chamadas conta junto). */
export function estimateMessagesTokens(
	messages: readonly LlmMessage[],
	toolsJsonChars = 0,
): number {
	let chars = Math.max(0, toolsJsonChars);
	for (const message of messages) {
		chars += textLength(message);
		// Conservador: itens opacos também ocupam a janela de contexto.
		if (message.providerItems) chars += JSON.stringify(message.providerItems).length;
		if (message.tool_calls) {
			chars += JSON.stringify(message.tool_calls).length;
		}
	}
	if (chars <= 0) return 0;
	return Math.max(
		1,
		Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
	);
}

function toolNameByCallId(messages: readonly LlmMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			if (call.id && call.function?.name) map.set(call.id, call.function.name);
		}
	}
	return map;
}

function positiveLimit(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Troca saídas gigantes de `tool` (ex.: extract/web com dezenas de KB) por um
 * stub: início + marcador de truncamento. Grupos antigos usam `maxChars`; o
 * grupo mais recente (resultado que o modelo AINDA não leu) usa o teto maior
 * `lastGroupMaxChars` — cortar em 8k ali escondia quase todo o resultado,
 * porque a higiene roda antes de cada passo. Sem teto nenhum, um extract de
 * 60k estourava o hard. Idempotente: conteúdo já espremido não é re-cortado.
 */
export function stubLargeToolOutputs(
	messages: readonly LlmMessage[],
	maxChars: number = STUB_TOOL_OUTPUT_MAX_CHARS,
	lastGroupMaxChars: number = STUB_LAST_GROUP_MAX_CHARS,
): LlmMessage[] {
	const limit = positiveLimit(maxChars, STUB_TOOL_OUTPUT_MAX_CHARS);
	const lastLimit = Math.max(
		limit,
		positiveLimit(lastGroupMaxChars, STUB_LAST_GROUP_MAX_CHARS),
	);
	let lastGroupStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "tool") {
			lastGroupStart = i;
			while (lastGroupStart > 0 && messages[lastGroupStart - 1]?.role === "tool") {
				lastGroupStart -= 1;
			}
			break;
		}
	}
	return messages.map((message, index) => {
		if (message.role !== "tool" || typeof message.content !== "string") {
			return message;
		}
		const cap = index >= lastGroupStart ? lastLimit : limit;
		// L3: a linha de referência do resultado guardado sobrevive ao corte (o modelo relê com artifact_read).
		const ref = extractResultRef(message.content);
		const body = ref ? stripResultRef(message.content) : message.content;
		if (body.length <= cap) return message;
		if (message.content.includes(STUB_TRUNCATED_MARKER)) return message;
		return {
			...message,
			content: `${body.slice(0, cap)}\n${STUB_TRUNCATED_MARKER} ${body.length} caracteres]${ref ? `\n${ref.line}` : ""}`,
		};
	});
}

/** Corridas consecutivas de `role=tool` (um grupo = os resultados de uma decisão). */
function listToolGroups(
	messages: readonly LlmMessage[],
): Array<{ start: number; end: number }> {
	const groups: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < messages.length; i += 1) {
		if (messages[i]?.role !== "tool") continue;
		let end = i;
		while (end + 1 < messages.length && messages[end + 1]?.role === "tool") {
			end += 1;
		}
		groups.push({ start: i, end });
		i = end;
	}
	return groups;
}

const isCollapsedTool = (message: LlmMessage): boolean =>
	typeof message.content === "string" &&
	message.content.startsWith(COLLAPSE_MARKER);

/** Colapso em lote (L4): quantas decisões acumulam antes de reescrever o prefixo. */
export const COLLAPSE_BATCH_SIZE = 4;
/** Teto de caracteres pendentes (grupos antigos ainda íntegros) antes de colapsar já. */
export const COLLAPSE_BATCH_MAX_CHARS = 60_000;

export type CollapseBatch = { size: number; maxPendingChars: number };

/**
 * Colapsar a cada passo reescreve o grupo anterior e derruba o cache de prompt
 * (o prefixo muda de bytes). Em lote, o histórico só cresce no fim entre dois
 * colapsos: colapsa quando há `size` grupos antigos íntegros ou quando eles
 * passam de `maxPendingChars` (proteção da janela). Determinístico: depende só
 * da conversa, então resume e retry decidem igual.
 */
export function shouldCollapseNow(
	messages: readonly LlmMessage[],
	batch: CollapseBatch,
	keepRecentGroups = 1,
): boolean {
	const groups = listToolGroups(messages);
	let pending = 0;
	let chars = 0;
	for (const group of groups.slice(0, Math.max(0, groups.length - Math.max(1, keepRecentGroups)))) {
		let fresh = false;
		for (let i = group.start; i <= group.end; i += 1) {
			const message = messages[i]!;
			if (isCollapsedTool(message)) continue;
			fresh = true;
			chars += textLength(message);
		}
		if (fresh) pending += 1;
	}
	return pending >= batch.size || chars > batch.maxPendingChars;
}

/** Índice da última mensagem `tool` já colapsada: fim do prefixo estável do histórico. */
export function lastCollapsedIndex(messages: readonly LlmMessage[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === "tool" && isCollapsedTool(message)) return i;
	}
	return undefined;
}

/**
 * Screenshots em lote: o canônico guarda todas, então a omissão é recalculada
 * a cada passo. Omitir "tudo menos as `keep` últimas" muda o prefixo a todo
 * passo; aqui o número de omitidas só sobe de `batch` em `batch`.
 */
export function omitOldScreenshotsInBatches(
	messages: readonly LlmMessage[],
	keep: number = KEEP_RECENT_SCREENSHOTS,
	batch: number = COLLAPSE_BATCH_SIZE,
): LlmMessage[] {
	let total = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		total += message.content.filter(isImagePart).length;
	}
	const extra = Math.max(0, total - Math.max(0, Math.floor(keep)));
	const omitted = Math.floor(extra / Math.max(1, batch)) * Math.max(1, batch);
	return omitOldScreenshots(messages, total - omitted);
}

/**
 * Colapsa grupos antigos de `tool` (corridas consecutivas de role=tool):
 * mantém os últimos `keepLastGroups` íntegros; anteriores viram UMA mensagem
 * por `tool_call_id` (textos do mesmo id juntados com " | ", 200 chars cada,
 * trecho total cap 300). Nunca funde o grupo num id único — toda chamada em
 * `tool_calls` do assistant continua com resposta correspondente. Grupos já
 * colapsados (marcador) são ignorados — idempotente entre resume/retries.
 * Nunca remove, só condensa.
 */
export function collapseOldToolGroups(
	messages: readonly LlmMessage[],
	keepLastGroups = 1,
	statusOf?: ToolStatusLookup,
): { messages: LlmMessage[]; collapsedGroups: number } {
	const groups = listToolGroups(messages);
	const targets = groups.slice(0, Math.max(0, groups.length - keepLastGroups));
	if (targets.length === 0) return { messages: [...messages], collapsedGroups: 0 };

	const namesById = toolNameByCallId(messages);
	const next: LlmMessage[] = [...messages];
	let collapsedGroups = 0;
	// Da direita para a esquerda para não deslocar índices.
	for (let g = targets.length - 1; g >= 0; g -= 1) {
		const group = targets[g]!;
		const slice = messages.slice(group.start, group.end + 1);
		if (
			slice.every(
				(item) =>
					typeof item.content === "string" &&
					item.content.startsWith(COLLAPSE_MARKER),
			)
		) {
			continue;
		}
		// Baldes por tool_call_id, em ordem de primeira aparição.
		const order: string[] = [];
		const byId = new Map<string, LlmMessage[]>();
		for (const item of slice) {
			const key = item.tool_call_id ?? "";
			if (!byId.has(key)) {
				byId.set(key, []);
				order.push(key);
			}
			byId.get(key)!.push(item);
		}
		const replacements: LlmMessage[] = [];
		for (const key of order) {
			const items = byId.get(key)!;
			const isCollapsed = (item: LlmMessage) =>
				typeof item.content === "string" &&
				item.content.startsWith(COLLAPSE_MARKER);
			for (const already of items.filter(isCollapsed)) {
				replacements.push(already);
			}
			const fresh = items.filter((item) => !isCollapsed(item));
			if (fresh.length === 0) continue;
			const name =
				(fresh[0]?.tool_call_id &&
					namesById.get(fresh[0].tool_call_id as string)) ??
				"tool";
			const texts: string[] = [];
			const refLines: string[] = [];
			for (const item of fresh) {
				if (typeof item.content === "string" && item.content.trim()) {
					// L3: o corte do trecho não pode levar a referência do resultado guardado junto.
					const ref = extractResultRef(item.content);
					if (ref) refLines.push(ref.line);
					texts.push((ref ? stripResultRef(item.content) : item.content).trim().slice(0, 200));
				}
			}
			const excerpt = texts.join(" | ").slice(0, 300);
			// O colapso corta o texto, mas o status estruturado (L20) segue visível:
			// falha não vira sucesso por perder o prefixo do erro.
			const statuses = fresh
				.map((item) => (item.tool_call_id ? statusOf?.(item.tool_call_id) : undefined))
				.filter((value) => Boolean(value));
			const statusLabel = statuses.length > 0 ? ` [status: ${[...new Set(statuses)].join("/")}]` : "";
			replacements.push({
				role: "tool",
				tool_call_id: fresh[0]?.tool_call_id,
				content:
					`${COLLAPSE_MARKER}: ${name}${statusLabel} ` +
					`(${fresh.length} resultado(s) antigos).` +
					(excerpt ? ` Trecho: ${excerpt}` : "") +
					(refLines.length > 0 ? ` ${refLines.join(" ")}` : ""),
			});
		}
		next.splice(group.start, slice.length, ...replacements);
		collapsedGroups += 1;
	}
	return { messages: next, collapsedGroups };
}

/**
 * Mantém todos os system + cauda de não-system, cortando SÓ em fronteira de
 * turno: anda de trás para frente tratando `assistant com tool_calls` +
 * respostas `tool` como unidade indivisível, até acumular `keepNonSystem`.
 * Nunca deixa tool sem o assistant com `tool_calls` correspondente, nem
 * assistant com `tool_calls` sem as respostas.
 */
export function trimHistory(messages: readonly LlmMessage[], keepNonSystem: number): LlmMessage[] {
	const systems = messages.filter((m) => m.role === "system");
	const rest = messages.filter((m) => m.role !== "system");
	if (rest.length <= keepNonSystem) return [...messages];
	if (keepNonSystem <= 0) return [...systems];
	// Quebra a cauda em unidades: [assistant+tools] | [assistant só] | [user/...].
	const units: LlmMessage[][] = [];
	let i = rest.length - 1;
	while (i >= 0) {
		const current = rest[i]!;
		if (current.role === "tool") {
			let start = i;
			while (start - 1 >= 0 && rest[start - 1]?.role === "tool") {
				start -= 1;
			}
			const parent = start - 1 >= 0 ? rest[start - 1] : undefined;
			if (
				parent?.role === "assistant" &&
				(parent.tool_calls?.length ?? 0) > 0
			) {
				units.unshift(rest.slice(start - 1, i + 1));
				i = start - 2;
			} else {
				units.unshift(rest.slice(start, i + 1));
				i = start - 1;
			}
		} else {
			units.unshift([current]);
			i -= 1;
		}
	}
	// Acumula unidades mais novas até atingir o orçamento (pode passar um
	// pouco — fronteira de turno tem precedência sobre a conta exata).
	const keptUnits: LlmMessage[][] = [];
	let keptCount = 0;
	for (let u = units.length - 1; u >= 0; u -= 1) {
		keptUnits.unshift(units[u]!);
		keptCount += units[u]!.length;
		if (keptCount >= keepNonSystem) break;
	}
	const tail = keptUnits.flat();
	// Systems primeiro (ordem original), depois a cauda.
	return [...systems, ...tail];
}

export type ToolStatusLookup = (toolCallId: string) => "ok" | "error" | "uncertain" | undefined;

export type HygieneOptions = {
	contextLength?: number | null;
	toolsJsonChars?: number;
	softRatio?: number;
	hardRatio?: number;
	softKeep?: number;
	hardKeep?: number;
	model?: string;
	/** L4: colapso em lote (prefixo estável entre lotes). Omitido = colapsa a cada passo. */
	collapseBatch?: CollapseBatch;
	/** Status estruturado por `tool_call_id`: o colapso o preserva no texto reduzido. */
	statusOf?: ToolStatusLookup;
	/** L14: orçamento operacional (alvo/teto em tokens). Omitido = só as guardas pela janela do modelo. */
	contextBudget?: ContextBudget;
	/** L14: estado da tarefa e objetivo para a nota de compactação. */
	taskState?: () => TaskState | undefined;
	objectiveText?: string;
	/** Run de código: tarefas, arquivos e falhas recentes entram na nota de compactação. */
	codingContext?: () => CodingNoteContext | undefined;
	/** Teto de caracteres de um resultado de ferramenta ainda inteiro (padrão 24 mil); sobe junto com o limite da conta. */
	lastGroupMaxChars?: number;
	/** Grupos de resultados de ferramenta mais recentes que o colapso nunca toca (padrão 1). */
	keepRecentGroups?: number;
	/** Só colapsa resultados antigos quando o contexto estimado passa disto (tokens); omitido = colapsa sempre que o lote encher. */
	collapseOverTokens?: number;
};

/**
 * Aplica colapso + guardas por janela. Retorna mensagens prontas + relatório.
 * Em pressão hard persistente (mensagem única gigante), bloqueia com erro
 * claro em vez de deixar o provider falhar silencioso.
 */
export function applyPromptHygiene(
	messages: readonly LlmMessage[],
	options: HygieneOptions = {},
): { messages: LlmMessage[]; report: HygieneReport } {
	const contextLength =
		typeof options.contextLength === "number" &&
		Number.isFinite(options.contextLength) &&
		options.contextLength > 0
			? Math.floor(options.contextLength)
			: DEFAULT_CONTEXT_LENGTH;
	const softRatio = options.softRatio ?? HYGIENE_SOFT_RATIO;
	const hardRatio = options.hardRatio ?? HYGIENE_HARD_RATIO;
	const softKeep = options.softKeep ?? HYGIENE_SOFT_KEEP;
	const hardKeep = options.hardKeep ?? HYGIENE_HARD_KEEP;
	const toolsJsonChars = options.toolsJsonChars ?? 0;

	const estimatedTokensBefore = estimateMessagesTokens(messages, toolsJsonChars);
	// Stub primeiro (inclusive o último grupo, que o collapse preserva), para
	// um extract gigante não estourar o hard antes de ser espremido.
	// Em lote, o corte de tamanho é o mesmo para todo grupo íntegro (o do último
	// grupo): senão o grupo recente encolheria de 24k para 8k ao envelhecer e
	// reescreveria o prefixo a todo passo.
	const batch = options.collapseBatch;
	const keepGroups = Math.max(1, Math.floor(options.keepRecentGroups ?? 1));
	// Sem pressão real de janela, resultados antigos ficam inteiros (o modelo ainda os usa); só o teto por resultado vale.
	const underPressure = (list: readonly LlmMessage[]) =>
		options.collapseOverTokens === undefined || estimateMessagesTokens(list, toolsJsonChars) >= options.collapseOverTokens;
	let working = batch
		? (() => {
				const stubbed = stubLargeToolOutputs(
					messages,
					options.lastGroupMaxChars ?? STUB_LAST_GROUP_MAX_CHARS,
					options.lastGroupMaxChars ?? STUB_LAST_GROUP_MAX_CHARS,
				);
				return shouldCollapseNow(stubbed, batch, keepGroups) && underPressure(stubbed)
					? collapseOldToolGroups(stubbed, keepGroups, options.statusOf)
					: { messages: stubbed, collapsedGroups: 0 };
			})()
		: (() => {
				const stubbed = stubLargeToolOutputs(messages, undefined, options.lastGroupMaxChars);
				return underPressure(stubbed)
					? collapseOldToolGroups(stubbed, keepGroups, options.statusOf)
					: { messages: stubbed, collapsedGroups: 0 };
			})();
	let guard: HygieneReport["guard"] = "none";

	const estimate = () => estimateMessagesTokens(working.messages, toolsJsonChars);

	let compaction: HygieneReport["compaction"];
	if (options.contextBudget) {
		const beforeCompaction = estimateMessagesTokens(working.messages, toolsJsonChars);
		const compacted = compactToBudget({
			messages: working.messages,
			budget: options.contextBudget,
			estimate: (list) => estimateMessagesTokens(list, toolsJsonChars),
			taskState: options.taskState?.(),
			objectiveText: options.objectiveText,
			coding: options.codingContext?.(),
			// Em pressão real: primeiro os antigos (mantendo os grupos recentes); só se não bastar, tudo menos o último.
			collapse: (list) => {
				const gentle = collapseOldToolGroups(list, keepGroups, options.statusOf).messages;
				return keepGroups > 1 && estimateMessagesTokens(gentle, toolsJsonChars) > options.contextBudget!.targetTokens
					? collapseOldToolGroups(gentle, 1, options.statusOf).messages
					: gentle;
			},
			trim: trimHistory,
		});
		if (compacted.compacted) {
			working = { messages: compacted.messages, collapsedGroups: working.collapsedGroups };
			compaction = { before: beforeCompaction, after: estimateMessagesTokens(working.messages, toolsJsonChars) };
		}
	}

	if (estimate() >= contextLength * softRatio) {
		guard = "soft";
		working = {
			messages: trimHistory(working.messages, softKeep),
			collapsedGroups: working.collapsedGroups,
		};
	}
	if (estimate() >= contextLength * hardRatio) {
		guard = "hard";
		working = { messages: trimHistory(working.messages, hardKeep), collapsedGroups: working.collapsedGroups };
	}
	const estimatedTokensAfter = estimate();
	if (estimatedTokensAfter >= contextLength * hardRatio) {
		const model = options.model ? ` do modelo ${options.model}` : "";
		throw new BudgetExhaustedError(
			`Contexto estimado em ~${estimatedTokensAfter.toLocaleString("pt-BR")} tokens ` +
				`(>${Math.round(hardRatio * 100)}% da janela de ${contextLength.toLocaleString("pt-BR")}${model}). ` +
				`Resuma a conversa ("Resumir agora") ou use um modelo com janela maior e tente de novo.`,
		);
	}

	return {
		messages: working.messages,
		report: {
			contextLength,
			estimatedTokensBefore,
			estimatedTokensAfter,
			collapsedGroups: working.collapsedGroups,
			trimmedMessages: messages.length - working.messages.length,
			guard,
			...(compaction ? { compaction } : {}),
		},
	};
}

// Reexporta o estimador para callers que só precisam medir.
export { estimateTokens };

/** Screenshots que o modelo ainda enxerga; as mais antigas viram marcador de texto. */
export const KEEP_RECENT_SCREENSHOTS = 2;

function isImagePart(part: LlmContentPart): boolean {
	return part.type === "image_url" || part.type === "screenshot_ref";
}

export function omitOldUserImages(messages: readonly LlmMessage[], keep = 4): LlmMessage[] {
	let remaining = messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_ref").length : 0), 0) - Math.max(0, Math.floor(keep));
	if (remaining <= 0) return [...messages];
	return messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		return { ...message, content: message.content.map((part): LlmContentPart => {
			if (part.type !== "image_ref" || remaining <= 0) return part;
			remaining--;
			return { type: "text", text: `[image omitted: "${(part.description ?? part.name ?? "image").slice(0, 120)}"]` };
		}) };
	});
}

/**
 * Imagens anexadas pelo usuário em lote (mesma ideia das screenshots): omitir
 * "tudo menos as `keep` últimas" reescreve um ponto do histórico a cada anexo novo
 * e derruba o cache de prompt; aqui o número de omitidas só sobe de `batch` em `batch`.
 */
export function omitOldUserImagesInBatches(
	messages: readonly LlmMessage[],
	keep = 4,
	batch: number = COLLAPSE_BATCH_SIZE,
): LlmMessage[] {
	let total = 0;
	for (const message of messages) {
		if (Array.isArray(message.content)) total += message.content.filter((part) => part.type === "image_ref").length;
	}
	const extra = Math.max(0, total - Math.max(0, Math.floor(keep)));
	const omitted = Math.floor(extra / Math.max(1, batch)) * Math.max(1, batch);
	return omitOldUserImages(messages, total - omitted);
}

/**
 * Só as `keep` screenshots mais recentes seguem no pacote enviado ao modelo
 * (cada imagem custa ~1k+ tokens e é reenviada em TODO passo seguinte). As
 * antigas viram "[screenshot omitted: <tool> at step N]". Pura e sem mutar:
 * o transcript canônico (e os artefatos) continuam intactos. Roda sobre a
 * forma canônica, ANTES de resolver `screenshot_ref` — as omitidas nem são
 * lidas do disco.
 */
export function omitOldScreenshots(
	messages: readonly LlmMessage[],
	keep: number = KEEP_RECENT_SCREENSHOTS,
): LlmMessage[] {
	const limit = Math.max(0, Math.floor(keep));
	let total = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		total += message.content.filter(isImagePart).length;
	}
	if (total <= limit) return [...messages];

	const toolNames = toolNameByCallId(messages);
	let toOmit = total - limit;
	let step = 0;
	let lastTool = "screenshot";
	return messages.map((message) => {
		if (message.role === "assistant") step += 1;
		if (message.role === "tool" && message.tool_call_id) {
			lastTool = toolNames.get(message.tool_call_id) ?? lastTool;
		}
		if (toOmit <= 0 || !Array.isArray(message.content)) return message;
		const parts = message.content.map((part): LlmContentPart => {
			if (toOmit <= 0 || !isImagePart(part)) return part;
			toOmit -= 1;
			return {
				type: "text",
				text: `[screenshot omitted: ${lastTool} at step ${step}]`,
			};
		});
		return { ...message, content: parts };
	});
}
