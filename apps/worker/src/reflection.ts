import {
	addMemoryEntry,
	appendProfileSuggestionCard,
	appendReflectionMessage,
	claimQueuedReflection,
	claimScheduledReflection,
	createDetachedProactiveRun,
	deleteOwnedMemory,
	ensureBotConversation,
	failStaleReflections,
	finishReflection,
	getBotModelForUser,
	getOwnedMemory,
	getPrimaryBot,
	getReflectionClock,
	getRunOutcome,
	hasActivitySince,
	listReflectionUsers,
	loadReflectionInput,
	requestRunCancel,
	updateOwnedMemory,
	getAccountConfig,
	recordMaintenanceResult,
	type Notify,
	type ReflectionRow,
} from "@workspace/db";
import {
	ReflectionFailure,
	isBotLanguage,
	isReflectionScheduleDue,
	reflectionFailureLogLine,
	reflectionSlotAt,
	reflectionTimeZone,
	toReflectionFailure,
	MAINTENANCE_NO_KEY_MESSAGE,
	REFLECTION_RECHECK_MAX_STEPS,
	type BotLanguage,
	type ReflectionFailureStage,
} from "@workspace/shared";
import type { WorkerConfig } from "./config.js";
import { resolveDefaultModelForJob } from "./run-config.js";
import { createMaintenanceLlm, type MaintenanceLlm } from "./maintenance-llm.js";
import { runReflection, type ReflectionPorts } from "./processors/reflection.js";

const SWEEP_INTERVAL_MS = 60_000;
const RECHECK_POLL_MS = 3_000;
const RECHECK_TIMEOUT_MS = 8 * 60_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "expired"]);

export type ReflectionSweeperDeps = {
	enqueueRun: (runId: string) => Promise<boolean>;
	config: WorkerConfig;
	notify?: Notify;
	now?: () => Date;
	log?: (line: string) => void;
	/** Injetável nos testes: cliente LLM da manutenção. */
	maintenanceLlm?: (userId: string) => Promise<MaintenanceLlm>;
};

function buildPorts(deps: ReflectionSweeperDeps, model: () => Promise<string>): ReflectionPorts {
	return {
		getOwnedMemory,
		updateOwnedMemory,
		deleteOwnedMemory,
		addMemory: async (input) => {
			const result = await addMemoryEntry({ userId: input.userId, botId: input.botId, target: "memory", content: input.content, category: input.category, importance: input.importance, source: input.source });
			return result.ok ? { ok: true, entry: result.entry ? { id: result.entry.id } : undefined } : { ok: false, error: result.error };
		},
		appendCard: (input) => appendProfileSuggestionCard(input),
		runRecheck: async ({ userId, botId, objective }) => {
			const run = await createDetachedProactiveRun({ userId, botId, model: await model(), objective, messages: [{ role: "user", content: objective }], maxSteps: REFLECTION_RECHECK_MAX_STEPS });
			if (!(await deps.enqueueRun(run.id).catch(() => false))) return null;
			const deadline = Date.now() + RECHECK_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, RECHECK_POLL_MS));
				const outcome = await getRunOutcome(run.id);
				if (outcome && TERMINAL.has(outcome.status)) return { status: outcome.status, text: outcome.resultText };
			}
			await requestRunCancel(run.id).catch(() => undefined);
			return null;
		},
	};
}

/** Executa uma reflexão já reservada (agendada ou manual). Nunca lança: a falha vira registro. */
export async function processReflectionRow(row: ReflectionRow, deps: ReflectionSweeperDeps): Promise<void> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const now = deps.now?.() ?? new Date();
	let stage: ReflectionFailureStage = "setup";
	let llm: MaintenanceLlm | null = null;
	try {
		llm = await (deps.maintenanceLlm ?? ((userId) => createMaintenanceLlm({ kind: "reflection", config: deps.config, userId })))(row.userId);
		if (llm.candidates.length === 0) throw new ReflectionFailure("no_api_key", "setup", MAINTENANCE_NO_KEY_MESSAGE);
		const primary = await getPrimaryBot(row.userId);
		if (!primary) {
			await finishReflection(row.id, { status: "skipped", detail: "sem bot principal" });
			return;
		}
		const account = await getAccountConfig(row.userId).catch(() => null);
		const timeZone = reflectionTimeZone(account?.general?.timezone);
		stage = "context";
		const conversationId = await ensureBotConversation(row.userId, primary.id);
		const [input, hasActivity] = await Promise.all([
			loadReflectionInput({ userId: row.userId, since: row.sinceAt, now, timeZone }),
			hasActivitySince(row.userId, row.sinceAt, now),
		]);
		const model = llm.model;
		const agentModel = async () =>
			(await getBotModelForUser(primary.id, row.userId)) ?? (await resolveDefaultModelForJob({ userId: row.userId, serverDefault: deps.config.openRouterModel }));
		const language: BotLanguage = isBotLanguage(primary.language) ? primary.language : "pt-BR";
		stage = "save";
		await runReflection(
			{ userId: row.userId, rowId: row.id, primary: { id: primary.id, name: primary.name, conversationId }, input, now },
			{
				ports: buildPorts(deps, agentModel),
				model,
				apiKey: "",
				complete: llm.completeWithTools,
				language,
				hasActivity,
				force: row.trigger === "manual",
				finish: (patch) => finishReflection(row.id, patch),
				postMessage: (conversation, text) => appendReflectionMessage(conversation, text, now, row.trigger === "manual" ? "agora" : "diária"),
				notify: deps.notify ? (userId, conversation, text) => deps.notify!(userId, conversation, "reminder", text) : undefined,
				log,
			},
		);
		await llm.report({ ok: true });
	} catch (error) {
		const failure = toReflectionFailure(error, stage);
		await (llm ? llm.report({ ok: false, error: new Error(failure.message) }) : recordMaintenanceResult(row.userId, "reflection", { ok: false, error: new Error(failure.message) })).catch(() => undefined);
		log(reflectionFailureLogLine(row.userId, failure));
		await finishReflection(row.id, { status: "failed", detail: failure.label, stats: { code: failure.code, stage: failure.stage, error: failure.message } }).catch((saveError) =>
			log(`[reflection] user=${row.userId} falhou ao gravar a falha: ${toReflectionFailure(saveError, "save").message}`),
		);
	}
}

/**
 * Varredura da reflexão: pedidos manuais ("Refletir agora") e a do dia, no horário escolhido pelo
 * usuário (fuso da conta). O banco é a fonte da verdade; sem sobreposição; nunca lança.
 */
export function startReflectionSweeper(deps: ReflectionSweeperDeps): { kick: () => void; stop: () => void } {
	let running = false;
	const sweep = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const now = deps.now?.() ?? new Date();
			await failStaleReflections(now);
			for (let queued = await claimQueuedReflection(now); queued; queued = await claimQueuedReflection(now)) {
				await processReflectionRow(queued, deps);
			}
			for (const user of await listReflectionUsers()) {
				const timeZone = reflectionTimeZone(user.timezone);
				const clock = await getReflectionClock(user.userId);
				if (!isReflectionScheduleDue({ settings: user.settings, timeZone, now, lastAttemptAt: clock.lastAttemptAt })) continue;
				const primary = await getPrimaryBot(user.userId);
				if (!primary) continue;
				const claimed = await claimScheduledReflection({ userId: user.userId, botId: primary.id, now, slotStart: reflectionSlotAt(now, timeZone, user.settings.time) });
				if (claimed) await processReflectionRow(claimed, deps);
			}
		} catch (error) {
			console.error("[reflection] sweep failed", error);
		} finally {
			running = false;
		}
	};
	const kick = (): void => {
		void sweep();
	};
	kick();
	const timer = setInterval(kick, SWEEP_INTERVAL_MS);
	return { kick, stop: () => clearInterval(timer) };
}
