import type { Job } from "bullmq";
import {
	ATLAS_JOB_NAMES,
	buildConversationTaskNote,
	buildSummaryPrompt,
	isAutomatedOrigin,
	parseSummaryResponse,
	type SummaryJobPayload,
	type SummaryJobResult,
} from "@workspace/shared";
import {
	getBotProfile,
	getConversationTaskContext,
	getLatestSummary,
	listActiveRunsForConversation,
	listConversationMessages,
	prisma,
	writeConversationSummary,
	resolveStoredReplyLanguage,
} from "@workspace/db";
import type { WorkerConfig } from "../config.js";
import { createMaintenanceLlm, type MaintenanceLlm } from "../maintenance-llm.js";

const TRANSCRIPT_MESSAGE_LIMIT = 200;
const TRANSCRIPT_CHAR_BUDGET = 30_000;
const MIN_NEW_MESSAGES = 5;

/** Dono da conversa: o perfil do bot só é lido se o bot for do mesmo usuário. */
async function conversationOwner(conversationId: string): Promise<string | undefined> {
	const row = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { userId: true } });
	return row?.userId ?? undefined;
}

/**
 * Resumo de conversa (Fase 1): roda no idle (sweeper) ou manual.
 * Modelo barato (SUMMARIZER_MODEL), nunca o do run. Transcript original
 * intacto — grava 1 versão nova em `conversation_summaries` e pronto.
 */
export async function processSummaryJob(
	job: Job<SummaryJobPayload, SummaryJobResult>,
	config: WorkerConfig,
	deps: { llm?: (userId: string | undefined) => Promise<MaintenanceLlm> } = {},
): Promise<SummaryJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.summaryWrite) {
		throw new Error(`Unexpected job name: ${job.name}`);
	}
	const { conversationId, botId } = job.data;
	if (!conversationId?.trim()) {
		throw new Error("conversationId vazio no job de resumo");
	}

	// Gate: nunca resumir com run ativo (evita resumir turno em voo).
	const active = await listActiveRunsForConversation(conversationId).catch(
		() => [],
	);
	if (active.length > 0) {
		return { summaryId: null, version: null, skipped: "run ativo" };
	}

	const latest = await getLatestSummary(conversationId).catch(() => null);
	const all = await listConversationMessages(conversationId, TRANSCRIPT_MESSAGE_LIMIT);
	const uncovered = latest?.rangeEnd
		? all.filter(
				(message) =>
					message.role !== "system" &&
					message.createdAt > (latest.rangeEnd as string),
			)
		: all.filter((message) => message.role !== "system");
	if (uncovered.length < MIN_NEW_MESSAGES) {
		return { summaryId: null, version: latest?.version ?? null, skipped: "pouco conteúdo novo" };
	}

	// Só user/assistant (tool output incha); mais antigas primeiro, teto de chars.
	const lines: string[] = [];
	const covered: Array<{ id: string; createdAt: string }> = [];
	let chars = 0;
	for (const message of uncovered.filter(
		(m) => m.role === "user" || m.role === "assistant",
	)) {
		// Saída de rotina/webhook é marcada: o resumo não a toma por tarefa do usuário.
		const automated = isAutomatedOrigin(message.origin);
		const speaker = automated ? "AUTOMATED" : message.role === "user" ? "USUÁRIO" : "ASSISTENTE";
		// Saída automatizada é curta no transcript: não gasta o orçamento que é das falas do usuário.
		const line = `${speaker}: ${message.content.trim()}`.slice(0, automated ? 400 : 2000);
		if (chars + line.length > TRANSCRIPT_CHAR_BUDGET) break;
		chars += line.length;
		lines.push(line);
		covered.push({ id: message.id, createdAt: message.createdAt });
	}
	if (lines.length === 0) {
		return { summaryId: null, version: latest?.version ?? null, skipped: "sem texto resumível" };
	}

	const ownerId = await conversationOwner(conversationId);
	const botProfile = botId ? await getBotProfile(botId, ownerId).catch(() => null) : null;
	// Tarefa ativa do usuário (do banco): o resumo a mantém no topo, com ids e links.
	const activeTask = ownerId
		? buildConversationTaskNote(await getConversationTaskContext(ownerId, conversationId).catch(() => null))
		: null;
	const language = await resolveStoredReplyLanguage({ userId: ownerId, conversationId, setting: botProfile?.language });
	const prompt = buildSummaryPrompt(
		[
			...(botProfile ? [`Contexto: bot "${botProfile.name}".`] : []),
			...lines,
		],
		latest
			? {
					content: latest.content,
					factsJson: latest.factsJson ?? undefined,
					version: latest.version,
				}
			: undefined,
		{ activeTask },
	);
	// Dono da conversa: o modelo de manutenção dele vale sobre o do servidor.
	const llm = await (deps.llm ?? ((userId) => createMaintenanceLlm({ kind: "summary", config, userId })))(ownerId);
	console.log(
		`[summary.write] start job=${job.id} conversation=${conversationId} lines=${lines.length} model=${llm.model}`,
	);

	let text: string;
	try {
		const result = await llm.complete({
			messages: [
				{ role: "system", content: language.instruction },
				{ role: "user", content: prompt },
			],
			model: llm.model,
			apiKey: "",
		});
		text = result.message.content ?? "";
		if (!text.trim()) {
			throw new Error("resumidor retornou vazio");
		}
	} catch (error) {
		await llm.report({ ok: false, error });
		throw error;
	}
	const { content, facts } = parseSummaryResponse(text);
	const first = covered[0];
	const last = covered[covered.length - 1];
	const saved = await writeConversationSummary({
		conversationId,
		content,
		facts,
		rangeStart: first ? new Date(first.createdAt) : null,
		rangeEnd: last ? new Date(last.createdAt) : null,
		snapshotVersion: last?.id ?? null,
	});
	await llm.report({ ok: true });
	console.log(
		`[summary.write] done job=${job.id} conversation=${conversationId} version=${saved.version}`,
	);
	return { summaryId: saved.id, version: saved.version };
}
