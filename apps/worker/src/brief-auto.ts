import { getAccountConfig, getBotPolicy, listAutoBriefCandidates, loadAutoBriefSignals, withBriefAutoLock, type AutoBriefCandidate, type AutoBriefSignals } from "@workspace/db";
import { listBriefSources, upsertDailyBrief } from "@workspace/agent-runtime";
import { canAutoEnableBrief, inferAutoBriefTime, readConfiguredQuietHours, readableBriefCategories, type BriefSource } from "@workspace/shared";

/**
 * "Seu dia" ligado por padrão: passo idempotente de garantia, chamado pela varredura do modo proativo
 * (nenhum agendador novo, nenhuma chamada de modelo). Para cada bot principal sem "Seu dia":
 * - pula quem recusou antes (`briefOptOut`), quem desligou o modo proativo de propósito e bot sem conversa;
 * - pula (e tenta de novo no dia seguinte) quem não tem fonte conectada nem pendência para mencionar;
 * - cria UMA rotina `daily_brief` (`createdBy: "bot"`), todo dia, no horário inferido da atividade do usuário,
 *   reaproveitando `upsertDailyBrief` em modo só-criar, sob lock por bot (várias instâncias do worker).
 * No máximo uma checagem por bot por dia (em memória: depois de reiniciar o worker a checagem é só repetida,
 * e é barata e idempotente) e a varredura inteira roda no máximo a cada `minIntervalMs`.
 */

const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;

export type AutoBriefOutcome = "created" | "exists" | "skipped_policy" | "skipped_no_conversation" | "skipped_no_sources" | "skipped_checked_today" | "failed";

export type AutoBriefDeps = {
	now?: () => Date;
	minIntervalMs?: number;
	listCandidates?: () => Promise<AutoBriefCandidate[]>;
	loadSignals?: (input: { userId: string; botId: string; conversationId: string | null; now: Date }) => Promise<AutoBriefSignals>;
	listSources?: (userId: string) => Promise<BriefSource[]>;
	accountTimezone?: (userId: string) => Promise<string | undefined>;
	readPolicy?: (botId: string, userId: string) => Promise<unknown>;
	withLock?: <T>(botId: string, fn: () => Promise<T>) => Promise<T>;
	upsert?: typeof upsertDailyBrief;
	log?: (line: string) => void;
};

const dayKey = (now: Date): string => now.toISOString().slice(0, 10);

/** Uma checagem de um bot. Nunca lança. */
export async function ensureAutoBrief(bot: AutoBriefCandidate, deps: AutoBriefDeps = {}): Promise<AutoBriefOutcome> {
	const now = (deps.now ?? (() => new Date()))();
	const log = deps.log ?? ((line: string) => console.log(line));
	try {
		if (!canAutoEnableBrief({ isPrimary: true, policyJson: bot.policyJson })) return "skipped_policy";
		// Sem conversa o brief não tem onde entrar (expiraria): fica para quando o bot tiver conversa.
		if (!bot.conversationId) return "skipped_no_conversation";
		const [sources, signals, timezone] = await Promise.all([
			(deps.listSources ?? listBriefSources)(bot.ownerId),
			(deps.loadSignals ?? loadAutoBriefSignals)({ userId: bot.ownerId, botId: bot.id, conversationId: bot.conversationId, now }),
			(deps.accountTimezone ?? defaultAccountTimezone)(bot.ownerId),
		]);
		if (readableBriefCategories(sources).length === 0 && !signals.hasPendingWork) return "skipped_no_sources";
		const time = inferAutoBriefTime({ userMessageAts: signals.userMessageAts, now, timeZone: timezone, quiet: readConfiguredQuietHours(bot.policyJson) });
		const run = deps.withLock ?? withBriefAutoLock;
		return await run(bot.id, async () => {
			// Relê a política sob o lock: um opt-out que chegou durante a checagem vale.
			const policy = await (deps.readPolicy ?? getBotPolicy)(bot.id, bot.ownerId);
			if (!canAutoEnableBrief({ isPrimary: true, policyJson: policy })) return "skipped_policy";
			const result = await (deps.upsert ?? upsertDailyBrief)(
				{ schedule: time.cron, ...(timezone ? { timezone } : {}) },
				{ userId: bot.ownerId, botId: bot.id, createdBy: "bot", createOnly: true },
			);
			if (result.created) log(`[brief-auto] bot=${bot.id} criado ${time.cron} basis=${time.basis}`);
			return result.created ? "created" : "exists";
		});
	} catch (error) {
		// Só o tipo do erro: a mensagem do Prisma pode trazer dado do usuário.
		log(`[brief-auto] bot=${bot.id} falhou (${error instanceof Error ? error.name : "erro"})`);
		return "failed";
	}
}

async function defaultAccountTimezone(userId: string): Promise<string | undefined> {
	return (await getAccountConfig(userId).catch(() => null))?.general?.timezone || undefined;
}

/**
 * Cria a função de varredura (`() => Promise<number>`, quantos briefs criou). Guarda o estado do dia em memória:
 * cada bot é checado uma vez por dia (UTC) e a varredura inteira respeita `minIntervalMs`. Nunca lança.
 */
export function createAutoBriefEnsurer(deps: AutoBriefDeps = {}): () => Promise<number> {
	const checked = new Map<string, string>();
	let lastSweepAt = 0;
	let running = false;
	return async () => {
		const now = (deps.now ?? (() => new Date()))();
		if (running || now.getTime() - lastSweepAt < (deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return 0;
		running = true;
		lastSweepAt = now.getTime();
		let created = 0;
		try {
			const today = dayKey(now);
			for (const [botId, day] of checked) if (day !== today) checked.delete(botId);
			for (const bot of await (deps.listCandidates ?? listAutoBriefCandidates)()) {
				if (checked.get(bot.id) === today) continue;
				const outcome = await ensureAutoBrief(bot, deps);
				// Erro de vez (ex.: banco fora do ar) tenta de novo na próxima varredura; o resto fica para amanhã.
				if (outcome !== "failed") checked.set(bot.id, today);
				if (outcome === "created") created += 1;
			}
		} catch (error) {
			(deps.log ?? console.error)(`[brief-auto] varredura falhou (${error instanceof Error ? error.name : "erro"})`);
		} finally {
			running = false;
		}
		return created;
	};
}
