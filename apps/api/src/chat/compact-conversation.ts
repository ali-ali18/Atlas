import {
	SUMMARY_MAX_OUTPUT_TOKENS,
	TransientRunError,
	buildTranscriptHistory,
	callSummaryWithRetry,
	cleanTranscript,
	compactTranscript,
	createMaintenanceLlm,
	namespaceToolCallIds,
	replaceCompactedHistory,
	type MaintenanceLlm,
	type SummarizeFn,
	type SummaryRetryOptions,
} from "@workspace/agent-runtime";
import {
	appendConversationCard,
	findCompactionBlocker,
	getBotProfile,
	getConversationTranscript,
	loadMessagesAfterWatermark,
	prisma,
	writeCompactedTranscript,
	type CompactionBlocker,
} from "@workspace/db";
import {
	COMPACT_CARD_SUMMARY_MAX_CHARS,
	COMPACT_FOCUS_MAX_CHARS,
	DEFAULT_MAINTENANCE_MODEL,
	compactionPercent,
	languageInstruction,
	type BotLanguage,
	type PersistedCompactionCard,
} from "@workspace/shared";

/**
 * `/compact`: resume a conversa que o próximo turno levaria e a torna o novo começo dela. Roda no servidor da
 * API (sem run): a conversa levada vive no checkpoint do último run de chat, e a compactação regrava ali
 * `llmMessages` (resumo + cauda recente), a marca d'água, e deixa o cartão "Conversa compactada" na thread.
 * Lista de tarefas, tools carregadas e notas levadas ficam no mesmo checkpoint e seguem como estavam.
 */

export type CompactOutcome =
	| { kind: "compacted"; before: number; after: number; percent: number; messageId: string; card: PersistedCompactionCard }
	| { kind: "noop"; reason: "too_small" | "no_transcript" | "already_compact"; message: string }
	| { kind: "blocked"; reason: CompactionBlocker | "busy" | "conflict"; message: string }
	| { kind: "failed"; message: string };

export const COMPACT_MESSAGES = {
	too_small: "A conversa ainda é curta; não há o que compactar.",
	already_compact: "A conversa já está compacta.",
	no_transcript: "Ainda não há conversa para compactar.",
	approval_pending: "Há uma aprovação pendente nesta conversa. Responda a ela antes de compactar.",
	run_active: "Há uma execução em andamento. Aguarde terminar para compactar a conversa.",
	busy: "Já existe uma compactação em andamento nesta conversa.",
	conflict: "A conversa mudou durante a compactação. Tente de novo.",
	failed: "Não consegui resumir a conversa agora. Tente de novo em instantes.",
} as const;

export type CompactDeps = {
	blocker: typeof findCompactionBlocker;
	loadTranscript: typeof getConversationTranscript;
	loadAfter: typeof loadMessagesAfterWatermark;
	write: typeof writeCompactedTranscript;
	appendCard: typeof appendConversationCard;
	/** Idioma do bot da conversa (o resumo sai nele). */
	language: (conversationId: string, userId: string) => Promise<BotLanguage>;
	/** Resumidor com o modelo de manutenção da conta (o mesmo do resumo de conversa); `report` grava o resultado no Diagnóstico. */
	summarizer: (userId: string) => Promise<{ summarize: SummarizeFn; report: (ok: boolean, error?: unknown) => Promise<void> }>;
	now: () => Date;
};

async function defaultLanguage(conversationId: string, userId: string): Promise<BotLanguage> {
	const row = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { bot: { select: { id: true } } } });
	if (!row?.bot) return "pt-BR";
	return ((await getBotProfile(row.bot.id, userId).catch(() => null))?.language ?? "pt-BR") as BotLanguage;
}

/** Só o tipo e o status do erro do provedor vão ao log: a mensagem pode trazer trechos da conversa ou da chave. */
function errorTag(error: unknown): string {
	const name = error instanceof Error ? error.name : "unknown";
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? `${name} ${status}` : name;
}

type CompactLlm = Pick<MaintenanceLlm, "model" | "completeWithTools" | "report">;

/**
 * Resumidor do `/compact` sobre o cliente da manutenção: uma nova tentativa em falha passageira (5xx, resposta
 * vazia, rede) dentro do prazo total; falhou de vez, registra no Diagnóstico e devolve `null` (a conversa fica como
 * estava e a pessoa vê a mensagem amigável).
 */
export function createCompactSummarizer(llm: CompactLlm, retry: SummaryRetryOptions = {}): { summarize: SummarizeFn; report: (ok: boolean, error?: unknown) => Promise<void> } {
	const summarize: SummarizeFn = async (request) => {
		try {
			const text = await callSummaryWithRetry(async (timeoutMs) => {
				const result = await llm.completeWithTools({
					messages: [
						{ role: "system", content: request.system },
						{ role: "user", content: request.user },
					],
					model: llm.model,
					apiKey: "",
					tools: [],
					toolChoice: "none",
					signal: AbortSignal.timeout(timeoutMs),
					timeoutMs,
					maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
				});
				const content = typeof result.message.content === "string" ? result.message.content.trim() : "";
				if (!content) throw new TransientRunError("summary came back empty");
				return content;
			}, { ...retry, onRetry: (error) => console.warn("compact summary call failed; retrying", errorTag(error)) });
			return { text };
		} catch (error) {
			console.error("compact summary call failed", errorTag(error));
			await llm.report({ ok: false, error });
			return null;
		}
	};
	return { summarize, report: async (ok, error) => { if (ok) await llm.report({ ok: true }); else if (error) await llm.report({ ok: false, error }); } };
}

async function defaultSummarizer(userId: string): ReturnType<CompactDeps["summarizer"]> {
	const llm = await createMaintenanceLlm({
		kind: "summary",
		config: { openRouterApiKey: process.env.OPENROUTER_API_KEY, summarizerModel: process.env.SUMMARIZER_MODEL?.trim() || DEFAULT_MAINTENANCE_MODEL },
		userId,
	});
	return createCompactSummarizer(llm);
}

const defaultDeps: CompactDeps = {
	blocker: findCompactionBlocker,
	loadTranscript: getConversationTranscript,
	loadAfter: loadMessagesAfterWatermark,
	write: writeCompactedTranscript,
	appendCard: appendConversationCard,
	language: defaultLanguage,
	summarizer: defaultSummarizer,
	now: () => new Date(),
};

/** Uma compactação por conversa por vez neste processo; entre processos, a gravação otimista decide. */
const inFlight = new Set<string>();

export async function compactConversation(
	input: { userId: string; conversationId: string; focus?: string },
	overrides: Partial<CompactDeps> = {},
): Promise<CompactOutcome> {
	const deps = { ...defaultDeps, ...overrides };
	const { userId, conversationId } = input;
	const focus = input.focus?.trim().slice(0, COMPACT_FOCUS_MAX_CHARS) || undefined;
	if (inFlight.has(conversationId)) return { kind: "blocked", reason: "busy", message: COMPACT_MESSAGES.busy };
	inFlight.add(conversationId);
	try {
		const transcript = await deps.loadTranscript(userId, conversationId);
		const blocker = await deps.blocker(conversationId, transcript?.createdAt);
		if (blocker) return { kind: "blocked", reason: blocker, message: COMPACT_MESSAGES[blocker] };
		const cleaned = transcript ? cleanTranscript(transcript.llmMessages) : null;
		if (!transcript || !transcript.watermark || !cleaned) return { kind: "noop", reason: "no_transcript", message: COMPACT_MESSAGES.no_transcript };
		// O que o próximo turno levaria: a conversa gravada mais o que a conversa ganhou depois dela (de outros autores).
		const after = await deps.loadAfter(conversationId, transcript.watermark, { excludeRunId: transcript.runId });
		if (!after.ok) return { kind: "noop", reason: "no_transcript", message: COMPACT_MESSAGES.no_transcript };
		const history = buildTranscriptHistory({
			transcript: namespaceToolCallIds(cleaned, transcript.runId),
			after: after.messages.map((message) => ({ role: message.role, content: message.content, createdAt: message.createdAt })),
			objective: "",
			priorRunEndedAt: transcript.finishedAt?.toISOString(),
		});
		const language = await deps.language(conversationId, userId);
		const { summarize, report } = await deps.summarizer(userId);
		const result = await compactTranscript({ transcript: history, summarize, languageInstruction: languageInstruction(language), ...(focus ? { focus } : {}) });
		if (result.status === "too_small") {
			const reason = result.alreadyCompact ? "already_compact" : "too_small";
			return { kind: "noop", reason, message: COMPACT_MESSAGES[reason] };
		}
		if (result.status === "failed") {
			await report(false, new Error(result.reason));
			return { kind: "failed", message: COMPACT_MESSAGES.failed };
		}
		await report(true);
		const written = await deps.write({
			userId,
			conversationId,
			transcript,
			llmMessages: replaceCompactedHistory(transcript.llmMessages, result.messages),
			compaction: { before: result.before, after: result.after, ...(focus ? { focus } : {}) },
			now: deps.now(),
		});
		if (!written) return { kind: "blocked", reason: "conflict", message: COMPACT_MESSAGES.conflict };
		const card: PersistedCompactionCard = {
			v: 1,
			kind: "compaction",
			before: result.before,
			after: result.after,
			summary: result.summary.slice(0, COMPACT_CARD_SUMMARY_MAX_CHARS),
			...(focus ? { focus } : {}),
		};
		// A conversa já foi trocada; sem o cartão persistido o cliente ainda mostra o que a resposta traz.
		const saved = await deps.appendCard(conversationId, card).catch((error: unknown) => {
			console.error("persist compaction card failed", error);
			return null;
		});
		return { kind: "compacted", before: result.before, after: result.after, percent: compactionPercent(result.before, result.after), messageId: saved?.id ?? `compaction-${deps.now().getTime()}`, card };
	} finally {
		inFlight.delete(conversationId);
	}
}
