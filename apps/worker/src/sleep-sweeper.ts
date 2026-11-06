/**
 * Agendador do sono (F5.3). Um passo barato a cada 5 minutos, SÓ de banco (nenhuma chamada ao modelo fora do horário):
 *  - sem a flag do v4, o passo nem consulta o banco; com ela, só as contas listadas;
 *  - por bot: já passou das 23:30 no fuso do dono e ainda não dormiu hoje? A reserva `(bot, tipo, dia)` do banco é a trava
 *    entre workers; uma memória do processo evita tentar a reserva de novo a cada passo;
 *  - domingo, depois do sono diário, o mesmo bot faz o "doctor" semanal.
 * Uma falha de um bot vira relatório `failed` (sem avançar a janela, o dia entra na próxima leitura) e nunca derruba o laço.
 * Mesmo desenho do varredor da reflexão (`reflection.ts`): o banco é a fonte da verdade, sem sobreposição, nunca lança.
 */
import { addMemoryEntry, claimSleepSlot, createNote, finishSleepReport, getAccountConfig, getMemorySnapshot, getPreviousSleepEnd, listBotsForSleep, listMemoryForDoctor, listNotes, loadSleepDay, type SleepBotRef } from "@workspace/db";
import { isEngineV4Enabled, isDoctorDay, isSleepDue, readSleepEnabled, reflectionTimeZone, sanitizeErrorMessage, sleepWindow, type EngineV4Gate, type SleepReportKind, type SleepSlot } from "@workspace/shared";
import type { WorkerConfig } from "./config.js";
import { engineV4GateFromEnv } from "./engine-choice.js";
import { createSleepLlm } from "./sleep-llm.js";
import { runDailySleep, runDoctor, type DoctorPorts, type SleepOutcome, type SleepPorts } from "./sleep-run.js";

export const SLEEP_SWEEP_INTERVAL_MS = 5 * 60_000;

export type SleepSweepDeps = {
	gate: () => EngineV4Gate;
	now: () => Date;
	log: (line: string) => void;
	db: {
		listBots(ownerIds: readonly string[]): Promise<SleepBotRef[]>;
		timezoneOf(userId: string): Promise<string>;
		claim(input: { userId: string; botId: string; kind: SleepReportKind; slot: string; now: Date }): Promise<{ id: string } | null>;
		finish: typeof finishSleepReport;
		previousEnd(userId: string, botId: string): Promise<Date | null>;
	};
	/** Portas do bot (modelo e banco), montadas só quando o bot vai dormir de fato. */
	portsFor(bot: SleepBotRef, reportId: string): Promise<SleepPorts & DoctorPorts>;
};

export const realSleepDb: SleepSweepDeps["db"] = {
	listBots: listBotsForSleep,
	timezoneOf: async (userId) => reflectionTimeZone((await getAccountConfig(userId).catch(() => null))?.general?.timezone),
	claim: claimSleepSlot,
	finish: finishSleepReport,
	previousEnd: getPreviousSleepEnd,
};

/** Portas reais de um bot: o modelo `sleep` do roteador do worker e as MESMAS funções de banco da UI e do chat (histórico desfazível). */
export function realPortsFor(config: WorkerConfig, log: (line: string) => void, makeLlm: typeof createSleepLlm = createSleepLlm): SleepSweepDeps["portsFor"] {
	return async (bot, reportId) => {
		const userId = bot.ownerId;
		const llm = await makeLlm({ userId, botId: bot.id, policyJson: bot.policyJson, config, log });
		return {
			llm,
			loadDay: (window) => loadSleepDay({ userId, botId: bot.id, ...window }),
			existingFacts: async () => {
				const snapshot = await getMemorySnapshot(userId, bot.id);
				return [...snapshot.user.entries.map((entry) => ({ layer: "owner" as const, content: entry.content })), ...snapshot.memory.entries.map((entry) => ({ layer: "bot" as const, content: entry.content }))];
			},
			addFact: async (fact) => {
				const result = await addMemoryEntry({ userId, botId: bot.id, target: fact.layer === "owner" ? "user" : "memory", content: fact.content, ...(fact.category && { category: fact.category }), source: "sleep", origin: "sleep", reportId });
				if (result.ok) return { status: "added" };
				return result.error === "duplicado" ? { status: "duplicate" } : { status: "rejected", reason: result.error };
			},
			addNote: async (note) => {
				const result = await createNote({ userId, botId: bot.id, title: note.title, body: note.body, pinned: false, origin: "sleep", reportId });
				if (result.ok) return { status: "added" };
				return result.code === "duplicate" ? { status: "duplicate" } : { status: "rejected", reason: result.message };
			},
			memory: () => listMemoryForDoctor({ userId, botId: bot.id }),
			notes: () => listNotes({ userId, botId: bot.id }),
		};
	};
}

type Job = { bot: SleepBotRef; slot: SleepSlot; kind: SleepReportKind; claimId: string };

async function execute(job: Job, deps: SleepSweepDeps, now: Date): Promise<void> {
	const { bot, slot, kind, claimId } = job;
	const userId = bot.ownerId;
	try {
		const ports = await deps.portsFor(bot, claimId);
		let outcome: SleepOutcome;
		let windowEnd: Date | undefined;
		if (kind === "daily") {
			const window = sleepWindow({ slotAt: slot.at, previousEnd: await deps.db.previousEnd(userId, bot.id) });
			outcome = await runDailySleep({ ports, botId: bot.id, window, slotKey: slot.key, language: bot.language });
			windowEnd = window.to;
		} else {
			outcome = await runDoctor({ ports, now, slotKey: slot.key, language: bot.language });
		}
		await deps.db.finish({ userId, id: claimId, status: outcome.status, ...(outcome.detail && { detail: outcome.detail }), ...(outcome.summary && { summary: outcome.summary }), proposals: outcome.proposals, stats: outcome.stats, ...(windowEnd && { windowEnd }), now });
		deps.log(`[sleep] bot=${bot.id} ${kind} ${slot.key} ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}`);
	} catch (error) {
		// O motivo vai para o relatório e o log sem segredo; a janela não avança, então o dia entra na próxima leitura.
		const detail = sanitizeErrorMessage(error);
		deps.log(`[sleep] bot=${bot.id} ${kind} ${slot.key} falhou: ${detail}`);
		await deps.db.finish({ userId, id: claimId, status: "failed", detail, now }).catch(() => undefined);
	}
}

/** Um passo do agendador. Exportado para teste; `done` guarda `bot:tipo:dia` já tratados neste processo. */
export async function sleepTick(deps: SleepSweepDeps, done: Set<string>): Promise<void> {
	const gate = deps.gate();
	if (!gate.enabled || gate.accounts.length === 0) return;
	const now = deps.now();
	const bots = await deps.db.listBots(gate.accounts);
	const zones = new Map<string, string>();
	for (const bot of bots) {
		if (!isEngineV4Enabled(gate, bot.ownerId) || !readSleepEnabled(bot.policyJson)) continue;
		if (!zones.has(bot.ownerId)) zones.set(bot.ownerId, await deps.db.timezoneOf(bot.ownerId));
		const { due, slot } = isSleepDue(now, zones.get(bot.ownerId)!);
		if (!due) continue;
		const kinds: SleepReportKind[] = isDoctorDay(slot) ? ["daily", "doctor"] : ["daily"];
		for (const kind of kinds) {
			const memo = `${bot.id}:${kind}:${slot.key}`;
			if (done.has(memo)) continue;
			done.add(memo);
			const claim = await deps.db.claim({ userId: bot.ownerId, botId: bot.id, kind, slot: slot.key, now });
			if (claim) await execute({ bot, slot, kind, claimId: claim.id }, deps, now);
		}
	}
	// A memória só precisa dos dias de hoje; descarta os antigos para não crescer sem fim.
	if (done.size > 5000) done.clear();
}

export function startSleepSweeper(input: { config: WorkerConfig; now?: () => Date; log?: (line: string) => void; intervalMs?: number; deps?: Partial<SleepSweepDeps> }): { kick: () => void; stop: () => void } {
	const log = input.log ?? ((line: string) => console.log(line));
	const deps: SleepSweepDeps = { gate: () => engineV4GateFromEnv(), now: input.now ?? (() => new Date()), log, db: realSleepDb, portsFor: realPortsFor(input.config, log), ...input.deps };
	const done = new Set<string>();
	let running = false;
	const kick = (): void => {
		if (running) return;
		running = true;
		sleepTick(deps, done)
			.catch((error) => console.error("[sleep] sweep failed", error))
			.finally(() => {
				running = false;
			});
	};
	kick();
	const timer = setInterval(kick, input.intervalMs ?? SLEEP_SWEEP_INTERVAL_MS);
	timer.unref?.();
	return { kick, stop: () => clearInterval(timer) };
}
