import type { Job } from "bullmq";
import {
	ATLAS_JOB_NAMES,
	decideMemoryScope,
	renderToolNotesBlock,
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
	memoryRef,
	removeMemoryEntry,
	replaceMemoryEntry,
} from "@workspace/db";
import {
	type ChatTool,
	type LlmMessage,
	completeChatWithTools,
} from "@workspace/llm";
import type { MemoryGateCandidate, MemoryGateVerdict, MemoryJudge } from "@workspace/agent-runtime";
import type { WorkerConfig } from "../config.js";
import { buildMemoryJudge } from "../memory-gate.js";
import { createMaintenanceLlm, type MaintenanceLlm } from "../maintenance-llm.js";

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
	/** Veredito do porteiro para este add/replace (julgado em lote antes). Ausente = grava direto. */
	verdict?: MemoryGateVerdict,
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

	if (verdict && action !== "remove" && content !== undefined) {
		if (verdict.action === "discard") return { ok: true, result: { ok: true, skipped: true, reason: `porteiro: ${verdict.reason}` } };
		// Fusão com uma entrada existente: o `add` vira um `replace` pela ref dela.
		if (verdict.action === "merge" && action === "add") {
			try {
				const merged = await ops.replaceMemoryEntry({ ...context, target, ref: memoryRef(verdict.entryId), content: verdict.content, category, importance, source: "memory-review" });
				if (merged.ok) return { ok: true, result: { ...merged, mergedWith: verdict.entryId } };
			} catch {
				// Segue para o `add` normal: perder a fusão não pode perder o fato.
			}
		}
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

type MemoryLayers = { user: { entries: { id?: string; content: string }[] }; memory: { entries: { id?: string; content: string }[] } };

/** Candidatos do passo (add/replace que passaram pela trava de escopo), por id da chamada, com o alvo já rebaixado. */
export function gateCandidates(calls: { id: string; function: { arguments: string } }[], hasBot: boolean, scope: MemoryScopeContext): Map<string, MemoryGateCandidate> {
	const out = new Map<string, MemoryGateCandidate>();
	for (const call of calls) {
		const args = parseArgs(call.function.arguments);
		const action = asAction(args.action);
		const target = asTarget(args.target);
		if ((action !== "add" && action !== "replace") || !target || typeof args.content !== "string") continue;
		const category = typeof args.category === "string" && args.category.trim() ? args.category.trim().slice(0, 64) : undefined;
		const decision = decideMemoryScope({ content: args.content, category, target, hasBot }, scope);
		if (decision.action !== "save") continue;
		const importance = typeof args.importance === "number" && Number.isFinite(args.importance) ? Math.max(0, Math.min(1, args.importance)) : undefined;
		out.set(call.id, { content: args.content, target: decision.target, category, importance, replaces: action === "replace" });
	}
	return out;
}

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
		llm?: MaintenanceLlm;
		profile?: typeof getBotProfile;
		snapshot?: (userId?: string, botId?: string) => Promise<MemoryLayers>;
		bots?: (userId: string | undefined) => Promise<{ name: string }[]>;
		/** Porteiro da memória (injetável nos testes); padrão: Jev + modelo de manutenção da conta. */
		judge?: MemoryJudge;
		/** Escrita da memória (injetável nos testes); padrão: banco. */
		ops?: MemoryOps;
	} = {},
): Promise<MemoryReviewJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.memoryReview) {
		throw new Error(`Unexpected job name: ${job.name}`);
	}

	const payload = job.data;
	const transcript: ChatMessage[] = payload.messages.slice(-TRANSCRIPT_LIMIT);
	const botProfile = await (deps.profile ?? getBotProfile)(payload.botId, payload.userId);
	const llm = deps.llm ?? (await createMaintenanceLlm({ kind: "memory-review", config, userId: payload.userId }, { completeChatWithTools: deps.complete }));
	const model = llm.model;
	const language = (botProfile?.language ?? "pt-BR") as BotLanguage;
	// Contexto da trava: nomes de todos os bots do usuário + perfil deste bot; falha aqui não derruba a revisão.
	const botNames = await (deps.bots ?? listBots)(payload.userId).then((bots) => bots.map((bot) => bot.name)).catch(() => [] as string[]);
	const scope: MemoryScopeContext = { botNames, botProfile };
	const snapshot = await (deps.snapshot ?? getMemorySnapshot)(payload.userId, payload.botId).catch(() => null);
	const current = renderCurrentMemories(snapshot);
	const gateLayers = {
		user: (snapshot?.user.entries ?? []).flatMap((entry) => (entry.id ? [{ id: entry.id, content: entry.content }] : [])),
		memory: (snapshot?.memory.entries ?? []).flatMap((entry) => (entry.id ? [{ id: entry.id, content: entry.content }] : [])),
	};
	const gateContext = transcript.slice(-4).map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
	let judge: MemoryJudge | undefined = deps.judge;

	const conversation: LlmMessage[] = [
		{ role: "system", content: [SYSTEM_PROMPT, current, renderToolNotesBlock(payload.toolNotes), languageInstruction(language)].filter(Boolean).join("\n\n") },
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
		const result = await llm.completeWithTools({
			messages: conversation,
			model,
			apiKey: "",
			tools: [MEMORY_TOOL],
		}).catch(async (error: unknown) => {
			await llm.report({ ok: false, error });
			throw error;
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

		// Porteiro: todos os fatos do passo vão numa só chamada; falha dele = grava como antes (fail-open).
		const candidates = gateCandidates(toolCalls, Boolean(payload.botId), scope);
		const verdicts = new Map<string, MemoryGateVerdict>();
		if (candidates.size > 0) {
			try {
				judge ??= await buildMemoryJudge({ userId: payload.userId, config });
				const ids = [...candidates.keys()];
				const judged = await judge({ candidates: ids.map((id) => candidates.get(id)!), existing: gateLayers, context: gateContext });
				ids.forEach((id, n) => judged[n] && verdicts.set(id, judged[n]!));
			} catch (error) {
				console.warn(`[memory.gate] warn review gate failed (${error instanceof Error ? error.name : "erro"}); saving as is`);
			}
		}

		for (const call of toolCalls) {
			const outcome = await executeMemoryTool(call.function.arguments, {
				userId: payload.userId,
				botId: payload.botId,
			}, deps.ops, scope, verdicts.get(call.id));

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

	await llm.report({ ok: true });
	console.log(`[memory.review] done job=${job.id} saved=${saved}`);
	return { saved, maintenance };
}
