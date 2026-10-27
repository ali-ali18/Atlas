import { getAccountConfig, getBotPolicy, listAutoBriefCandidates, loadAutoBriefSignals, markBriefAutoChecked, withBriefAutoLock, type AutoBriefCandidate, type AutoBriefSignals } from "@workspace/db";
import { listBriefSources, upsertDailyBrief } from "@workspace/agent-runtime";
import { briefCheckDayKey, canAutoEnableBrief, isBriefCheckDue, isValidTimeZone, inferAutoBriefTime, readConfiguredQuietHours, readableBriefCategories, type BriefSource, type RoutineRecord } from "@workspace/shared";

/**
 * "Seu dia" ligado por padrão: passo idempotente de garantia, chamado pela varredura do modo proativo
 * (nenhum agendador novo, nenhuma chamada de modelo). Para cada bot principal sem "Seu dia":
 * - pula quem recusou antes (`briefOptOut`), quem desligou o modo proativo de propósito e bot sem conversa;
 * - pula quem não tem fonte conectada nem pendência para mencionar (grava a data; recheca em 7 dias);
 * - cria UMA rotina `daily_brief` (`createdBy: "bot"`), todo dia, no horário inferido da atividade do usuário,
 *   reaproveitando `upsertDailyBrief` em modo só-criar, sob lock por bot (várias instâncias do worker).
 * A varredura é limitada por orçamento e cursor (ver `createAutoBriefEnsurer`).
 */

const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;
const DEFAULT_MAX_CHECKS = 20;
const DEFAULT_MAX_SCAN = 500;
const DEFAULT_PAGE_SIZE = 50;

export type AutoBriefOutcome = "created" | "exists" | "skipped_policy" | "skipped_no_conversation" | "skipped_no_sources" | "skipped_not_due" | "failed";

export type AutoBriefDeps = {
	now?: () => Date;
	minIntervalMs?: number;
	/** Checagens com consulta por varredura (orçamento), bots lidos por varredura e tamanho da página. */
	maxChecksPerSweep?: number;
	maxScanPerSweep?: number;
	pageSize?: number;
	listCandidates?: (input: { afterId: string | null; limit: number }) => Promise<AutoBriefCandidate[]>;
	/** Grava a data da checagem "sem fonte" (`briefAutoCheckedAt`). */
	markChecked?: (userId: string, botId: string, day: string) => Promise<void>;
	loadSignals?: (input: { userId: string; botId: string; conversationId: string | null; now: Date }) => Promise<AutoBriefSignals>;
	listSources?: (userId: string) => Promise<BriefSource[]>;
	accountTimezone?: (userId: string) => Promise<string | undefined>;
	readPolicy?: (botId: string, userId: string) => Promise<unknown>;
	withLock?: <T>(botId: string, fn: () => Promise<T>) => Promise<T>;
	upsert?: typeof upsertDailyBrief;
	/** Agenda o cron da rotina recém-criada (fora de um run ninguém mais o faria até o worker reiniciar). */
	onCreated?: (routine: RoutineRecord) => Promise<void>;
	log?: (line: string) => void;
};

/** Uma checagem de um bot. Nunca lança. */
export async function ensureAutoBrief(bot: AutoBriefCandidate, deps: AutoBriefDeps = {}): Promise<AutoBriefOutcome> {
	const now = (deps.now ?? (() => new Date()))();
	const log = deps.log ?? ((line: string) => console.log(line));
	try {
		if (!canAutoEnableBrief({ isPrimary: true, policyJson: bot.policyJson })) return "skipped_policy";
		// Sem conversa o brief não tem onde entrar (expiraria): fica para quando o bot tiver conversa.
		if (!bot.conversationId) return "skipped_no_conversation";
		// Sem fonte na última checagem: só volta a olhar depois de BRIEF_RECHECK_DAYS dias (a data está no banco).
		if (!isBriefCheckDue(bot.policyJson, now)) return "skipped_not_due";
		const [sources, signals, timezone] = await Promise.all([
			(deps.listSources ?? listBriefSources)(bot.ownerId),
			(deps.loadSignals ?? loadAutoBriefSignals)({ userId: bot.ownerId, botId: bot.id, conversationId: bot.conversationId, now }),
			(deps.accountTimezone ?? defaultAccountTimezone)(bot.ownerId),
		]);
		if (readableBriefCategories(sources).length === 0 && !signals.hasPendingWork) {
			await (deps.markChecked ?? markBriefAutoChecked)(bot.ownerId, bot.id, briefCheckDayKey(now)).catch(() => log(`[brief-auto] bot=${bot.id} data da checagem não gravada`));
			return "skipped_no_sources";
		}
		const zone = isValidTimeZone(timezone) ? timezone : undefined;
		const time = inferAutoBriefTime({ userMessageAts: signals.userMessageAts, now, timeZone: zone, quiet: readConfiguredQuietHours(bot.policyJson) });
		const run = deps.withLock ?? withBriefAutoLock;
		return await run(bot.id, async () => {
			// Relê a política sob o lock: um opt-out que chegou durante a checagem vale.
			const policy = await (deps.readPolicy ?? getBotPolicy)(bot.id, bot.ownerId);
			if (!canAutoEnableBrief({ isPrimary: true, policyJson: policy })) return "skipped_policy";
			const result = await (deps.upsert ?? upsertDailyBrief)(
				{ schedule: time.cron, ...(zone ? { timezone: zone } : {}) },
				{ userId: bot.ownerId, botId: bot.id, createdBy: "bot", createOnly: true, ...(deps.onCreated ? { onCreated: scheduleCreated(deps.onCreated, bot.id, log) } : {}) },
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

/**
 * Falha ao agendar não desfaz a rotina criada (ela existe e o dono a vê): loga só o tipo do erro, e o
 * `rehydrateRoutineSchedulers` do próximo boot do worker agenda. Não deixa o ensure marcar o bot como "falhou".
 */
function scheduleCreated(onCreated: (routine: RoutineRecord) => Promise<void>, botId: string, log: (line: string) => void) {
	return async (routine: RoutineRecord): Promise<void> => {
		try {
			await onCreated(routine);
		} catch (error) {
			log(`[brief-auto] bot=${botId} criado, mas o agendamento falhou (${error instanceof Error ? error.name : "erro"})`);
		}
	};
}

async function defaultAccountTimezone(userId: string): Promise<string | undefined> {
	const zone = (await getAccountConfig(userId).catch(() => null))?.general?.timezone;
	// Fuso inválido na conta: sem ele o horário usa o padrão (America/Sao_Paulo) em vez de lançar no agendador.
	return isValidTimeZone(zone) ? zone : undefined;
}

/** Resultados que gastaram consulta (fontes, sinais, lock): contam no orçamento da varredura. Os outros são decididos só pela política. */
const SPENT: ReadonlySet<AutoBriefOutcome> = new Set(["created", "exists", "skipped_no_sources", "failed"]);

/**
 * Cria a função de varredura (`() => Promise<number>`, quantos briefs criou). Fora do caminho crítico do sweep:
 * - orçamento: no máximo `maxChecksPerSweep` checagens com consulta por varredura e `maxScanPerSweep` bots lidos;
 * - cursor (em memória) por id: a varredura seguinte continua de onde parou e dá a volta no fim da lista;
 * - sem estado em memória do dia: bot com brief sai da lista; bot sem fonte tem a data gravada no banco
 *   (`briefAutoCheckedAt`) e só é rechecado depois de `BRIEF_RECHECK_DAYS` dias, por qualquer instância.
 * A varredura inteira também respeita `minIntervalMs`. Nunca lança.
 */
export function createAutoBriefEnsurer(deps: AutoBriefDeps = {}): () => Promise<number> {
	let cursor: string | null = null;
	let lastSweepAt = 0;
	let running = false;
	return async () => {
		const now = (deps.now ?? (() => new Date()))();
		if (running || now.getTime() - lastSweepAt < (deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return 0;
		running = true;
		lastSweepAt = now.getTime();
		const budget = deps.maxChecksPerSweep ?? DEFAULT_MAX_CHECKS;
		const maxScan = deps.maxScanPerSweep ?? DEFAULT_MAX_SCAN;
		const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
		let created = 0;
		try {
			let spent = 0;
			let scanned = 0;
			while (spent < budget && scanned < maxScan) {
				const page = await (deps.listCandidates ?? listAutoBriefCandidates)({ afterId: cursor, limit: pageSize });
				for (const bot of page) {
					cursor = bot.id;
					scanned += 1;
					const outcome = await ensureAutoBrief(bot, deps);
					if (SPENT.has(outcome)) spent += 1;
					if (outcome === "created") created += 1;
					if (spent >= budget) break;
				}
				// Página curta = fim da lista: a próxima varredura recomeça do início.
				if (page.length < pageSize) {
					cursor = null;
					break;
				}
			}
		} catch (error) {
			(deps.log ?? console.error)(`[brief-auto] varredura falhou (${error instanceof Error ? error.name : "erro"})`);
		} finally {
			running = false;
		}
		return created;
	};
}
