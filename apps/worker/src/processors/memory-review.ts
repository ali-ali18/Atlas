import type { Job } from "bullmq";
import {
	ATLAS_JOB_NAMES,
	decideMemoryScope,
	languageInstruction,
	type MemoryScopeContext,
	type BotLanguage,
	type ChatMessage,
	type MemoryReviewJobPayload,
	type MemoryReviewJobResult,
	type MemoryTarget,
} from "@workspace/shared";
import {
	addMemoryEntry,
	getBotProfile,
	getMemorySnapshot,
	listBots,
	removeMemoryEntry,
	replaceMemoryEntry,
} from "@workspace/db";
import {
	type ChatTool,
	type LlmMessage,
	completeChatWithTools,
} from "@workspace/llm";
import type { WorkerConfig } from "../config.js";
import { resolveMaintenanceModelForJob } from "../run-config.js";

const MAX_STEPS = 4;
const TRANSCRIPT_LIMIT = 20;

const SYSTEM_PROMPT = [
	"Você é o revisor de memória. Analise a conversa e salve APENAS fatos duráveis e úteis para interações futuras.",
	"",
	"ISOLAMENTO: cada bot é um agente separado. O target `user` é COMPARTILHADO com TODOS os bots do usuário;",
	"o target `memory` é só DESTE bot. Na dúvida, use `memory`; se nem isso fizer sentido, não salve.",
	"",
	"target `user` = SOMENTE fato pessoal estável sobre a PESSOA, que valeria em qualquer bot.",
	"Categorias permitidas: identidade, preferencia, idioma, fuso, comunicacao, contato, profissao, localizacao, formacao.",
	"  BOM: \"Nome: Maria Souza, apelido Mari\"; \"Mora em Curitiba, fuso America/Sao_Paulo\"; \"Trabalha como contadora\";",
	"  \"Estuda Direito na PUCPR\"; \"Fala pt-BR e prefere respostas curtas\".",
	"",
	"target `memory` = o que é só deste bot: tarefas e projetos pedidos, decisões, empresas, finanças, ambiente e fluxo de trabalho.",
	"  BOM: \"Cliente Silva paga todo dia 10 por boleto\"; \"Quer ajuda principalmente com bugs e documentação neste bot\".",
	"",
	"NÃO SALVE (em nenhum target):",
	"- A descrição, o papel, o tom ou as instruções do PRÓPRIO bot (ex.: \"Bot X: assistente amigável para finanças\",",
	"  \"Tom amigável; só corrigir e manter breve\"). Isso já está no perfil do bot.",
	"- Pedido de rotina, lembrete ou tarefa agendada (ex.: \"quer uma rotina diária às 7h para ver a agenda\"). Rotinas vivem em Rotinas.",
	"- Resumo do que foi criado/configurado na conversa, nem o que o usuário pediu para ESTE bot fazer em `user` (no máximo em `memory`).",
	"- Nada que já conste em \"Memórias atuais\" abaixo (não duplique; use replace para corrigir ou atualizar).",
	"- Informações triviais, efêmeras ou óbvias.",
	"",
	"Seja compacto e denso (frases curtas). Para cada fato, informe `category` e `importance` 0-1 (>= 0.7 só p/ o que muda decisões futuras).",
	"Se nada merecer ser salvo, NÃO chame a ferramenta.",
	"Use a ferramenta `memory` para adicionar, substituir ou remover entradas.",
	"Quando uma ação falhar por limite de espaço, consolide as entradas informadas (currentEntries) e tente novamente.",
].join("\n");

const MEMORY_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "memory",
		description:
			"Gerencia a memória durável (user = só perfil pessoal estável, compartilhado entre bots; memory = notas e contexto deste bot).",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["add", "replace", "remove"],
					description: "Operação a executar.",
				},
				target: {
					type: "string",
					enum: ["user", "memory"],
					description: "Camada de memória afetada.",
				},
				content: {
					type: "string",
					description: "Conteúdo para add/replace.",
				},
				old_text: {
					type: "string",
					description: "Trecho existente para replace/remove.",
				},
				category: {
					type: "string",
					description: "Categoria curta do fato.",
				},
				importance: {
					type: "number",
					description: "Importância de 0 a 1 (>= 0.7 só p/ decisivos).",
				},
			},
			required: ["action", "target"],
		},
	},
};

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || "{}");
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function asAction(value: unknown): "add" | "replace" | "remove" | null {
	return value === "add" || value === "replace" || value === "remove"
		? value
		: null;
}

function asTarget(value: unknown): MemoryTarget | null {
	return value === "user" || value === "memory" ? value : null;
}

export type MemoryOps = {
	addMemoryEntry: typeof addMemoryEntry;
	replaceMemoryEntry: typeof replaceMemoryEntry;
	removeMemoryEntry: typeof removeMemoryEntry;
};

export async function executeMemoryTool(
	rawArgs: string,
	context: { userId?: string; botId?: string },
	ops: MemoryOps = { addMemoryEntry, replaceMemoryEntry, removeMemoryEntry },
	scope: MemoryScopeContext = {},
): Promise<{ ok: boolean; result: unknown }> {
	const args = parseArgs(rawArgs);
	const action = asAction(args.action);
	const requestedTarget = asTarget(args.target);
	const content = typeof args.content === "string" ? args.content : undefined;
	const oldText =
		typeof args.old_text === "string" ? args.old_text : undefined;
	const category =
		typeof args.category === "string" && args.category.trim().length > 0
			? args.category.trim().slice(0, 64)
			: undefined;
	const importance =
		typeof args.importance === "number" && Number.isFinite(args.importance)
			? Math.max(0, Math.min(1, args.importance))
			: undefined;

	if (!action || !requestedTarget) {
		return {
			ok: false,
			result: { ok: false, error: "parâmetros inválidos: action/target obrigatórios" },
		};
	}

	// add/replace passam pela trava determinística: rotina é recusada, o que repete o perfil do bot é
	// pulado e o que não é perfil pessoal estável é rebaixado para `memory`. remove mantém o alvo pedido.
	let target = requestedTarget;
	let demotedReason: string | undefined;
	if (action !== "remove" && content !== undefined) {
		const decision = decideMemoryScope({ content, category, target: requestedTarget, hasBot: Boolean(context.botId) }, scope);
		if (decision.action === "reject") {
			return { ok: false, result: { ok: false, error: `não salvo: ${decision.reason}. Rotinas e lembretes agendados vivem em Rotinas, não na memória.` } };
		}
		if (decision.action === "skip") return { ok: true, result: { ok: true, skipped: true, reason: decision.reason } };
		target = decision.target;
		if (target !== requestedTarget) demotedReason = decision.reason;
	}

	try {
		if (action === "add") {
			if (content === undefined) {
				return {
					ok: false,
					result: { ok: false, error: "content obrigatório para add" },
				};
			}
			const result = await ops.addMemoryEntry({
				...context,
				target,
				content,
				category,
				importance,
				source: "memory-review",
			});
			if (!result.ok && result.error === "duplicado") {
				return { ok: true, result: { ...result, skipped: true } };
			}
			// Add termina aqui: sem return ele cairia no ramo remove (erro falso ou
			// remoção indevida quando o modelo manda old_text junto).
			return { ok: result.ok, result: demotedReason ? { ...result, movedTo: target, reason: demotedReason } : result };
		}

		if (action === "replace") {
			if (content === undefined || oldText === undefined) {
				return {
					ok: false,
					result: {
						ok: false,
						error: "content e old_text obrigatórios para replace",
					},
				};
			}
			const result = await ops.replaceMemoryEntry({
				...context,
				target,
				oldText,
				content,
				category,
				importance,
				source: "memory-review",
			});
			return { ok: result.ok, result: demotedReason ? { ...result, movedTo: target, reason: demotedReason } : result };
		}

		if (oldText === undefined) {
			return {
				ok: false,
				result: { ok: false, error: "old_text obrigatório para remove" },
			};
		}
		const result = await ops.removeMemoryEntry({ ...context, target, oldText, origin: "review" });
		return { ok: result.ok, result };
	} catch (error) {
		return {
			ok: false,
			result: {
				ok: false,
				error:
					error instanceof Error ? error.message : "erro ao executar ação",
			},
		};
	}
}

const MEMORIES_PER_LAYER = 30;
const MEMORY_SNIPPET_CHARS = 200;

type MemoryLayers = { user: { entries: { content: string }[] }; memory: { entries: { content: string }[] } };

/** Bloco compacto com o que já está salvo (user + este bot), para o revisor atualizar em vez de duplicar. */
export function renderCurrentMemories(snapshot: MemoryLayers | null): string {
	if (!snapshot) return "";
	const line = (entry: { content: string }) => `- ${entry.content.replace(/\s+/g, " ").trim().slice(0, MEMORY_SNIPPET_CHARS)}`;
	const layer = (label: string, entries: { content: string }[]) => (entries.length === 0 ? `${label}: (vazio)` : [`${label}:`, ...entries.slice(0, MEMORIES_PER_LAYER).map(line)].join("\n"));
	return ["Memórias atuais", layer("user (compartilhado)", snapshot.user.entries), layer("memory (este bot)", snapshot.memory.entries)].join("\n");
}

export async function processMemoryReview(
	job: Pick<Job<MemoryReviewJobPayload, MemoryReviewJobResult>, "name" | "data" | "id">,
	config: WorkerConfig,
	deps: {
		complete?: typeof completeChatWithTools;
		profile?: typeof getBotProfile;
		snapshot?: (userId?: string, botId?: string) => Promise<MemoryLayers>;
		bots?: (userId: string | undefined) => Promise<{ name: string }[]>;
	} = {},
): Promise<MemoryReviewJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.memoryReview) {
		throw new Error(`Unexpected job name: ${job.name}`);
	}

	if (!config.openRouterApiKey) {
		throw new Error("OPENROUTER_API_KEY is not configured on the worker");
	}

	const payload = job.data;
	const apiKey = config.openRouterApiKey;
	const transcript: ChatMessage[] = payload.messages.slice(-TRANSCRIPT_LIMIT);
	const botProfile = await (deps.profile ?? getBotProfile)(payload.botId, payload.userId);
	const model = await resolveMaintenanceModelForJob({
		kind: "memory-review",
		config,
		userId: payload.userId,
		conversationId: payload.conversationId,
	});
	const language = (botProfile?.language ?? "pt-BR") as BotLanguage;
	// Contexto da trava: nomes de todos os bots do usuário + perfil deste bot; falha aqui não derruba a revisão.
	const botNames = await (deps.bots ?? listBots)(payload.userId).then((bots) => bots.map((bot) => bot.name)).catch(() => [] as string[]);
	const scope: MemoryScopeContext = { botNames, botProfile };
	const current = renderCurrentMemories(await (deps.snapshot ?? getMemorySnapshot)(payload.userId, payload.botId).catch(() => null));

	const conversation: LlmMessage[] = [
		{ role: "system", content: [SYSTEM_PROMPT, current, languageInstruction(language)].filter(Boolean).join("\n\n") },
		...transcript.map((message) => ({
			role: message.role,
			content: message.content,
		})),
	];

	console.log(
		`[memory.review] start job=${job.id} messages=${transcript.length} botId=${payload.botId ?? "-"}`,
	);

	let saved = 0;
	const maintenance: NonNullable<MemoryReviewJobResult["maintenance"]> = { model, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

	for (let step = 0; step < MAX_STEPS; step += 1) {
		const result = await (deps.complete ?? completeChatWithTools)({
			messages: conversation,
			model,
			apiKey,
			tools: [MEMORY_TOOL],
		});

		maintenance.calls += 1;
		maintenance.model = result.model;
		maintenance.promptTokens += result.usage?.promptTokens ?? 0;
		maintenance.completionTokens += result.usage?.completionTokens ?? 0;
		maintenance.totalTokens += result.usage?.totalTokens ?? (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0);
		if (result.usage?.costUsd !== undefined) maintenance.costUsd = (maintenance.costUsd ?? 0) + result.usage.costUsd;
		const message = result.message;
		const toolCalls = message.tool_calls ?? [];
		if (toolCalls.length === 0) {
			break;
		}

		conversation.push({
			role: "assistant",
			content: message.content,
			tool_calls: toolCalls,
		});

		for (const call of toolCalls) {
			const outcome = await executeMemoryTool(call.function.arguments, {
				userId: payload.userId,
				botId: payload.botId,
			}, undefined, scope);

			if (outcome.ok && !(outcome.result as { skipped?: boolean } | null)?.skipped) {
				saved += 1;
			}

			conversation.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(outcome.result),
			});
		}
	}

	console.log(`[memory.review] done job=${job.id} saved=${saved}`);
	return { saved, maintenance };
}
