/**
 * Card de rotina que o bot propôs sozinho (modo proativo). Sugerir: espera "Criar" /
 * "Agora não". Automático: a rotina já existe e o card oferece "Manter" / "Desfazer".
 * Os dados da proposta moram no próprio card (sem fila separada): aceitar cria a rotina
 * a partir dele, e o clique é validado contra o dono da conversa.
 */
import { cronToScheduleInput, isCronFive } from "./schedule-cron.js";
import { INTERVAL_EVERY_MINUTES_MAX, INTERVAL_EVERY_MINUTES_MIN } from "./routine-interval.js";

export type RoutineProposalSpec = {
	name: string;
	/** Instrução que o bot segue a cada disparo. */
	prompt: string;
	/** Cron de 5 campos (rotina por horário) ... */
	schedule?: string;
	/** ... ou intervalo fixo em minutos. Um dos dois. */
	everyMinutes?: number;
	timezone: string;
};

export type RoutineProposalMode = "suggest" | "auto";
/** accepted = criada (Sugerir) ou mantida (Automático); declined = recusada ou desfeita. */
export type RoutineProposalStatus = "pending" | "accepted" | "declined";

export type PersistedRoutineProposalCard = {
	v: 1;
	kind: "routine-proposal";
	proposalId: string;
	mode: RoutineProposalMode;
	status: RoutineProposalStatus;
	spec: RoutineProposalSpec;
	/** Presente quando a rotina existe (Automático, ou Sugerir depois de aceita). */
	routineId?: string;
};

export const ROUTINE_PROPOSAL_NAME_MAX = 120;
export const ROUTINE_PROPOSAL_PROMPT_MAX = 4000;

export function parseRoutineProposalSpec(raw: unknown): RoutineProposalSpec | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const name = typeof row.name === "string" ? row.name.trim() : "";
	const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
	const timezone = typeof row.timezone === "string" && row.timezone.trim() ? row.timezone.trim().slice(0, 64) : "";
	if (!name || name.length > ROUTINE_PROPOSAL_NAME_MAX || !prompt || prompt.length > ROUTINE_PROPOSAL_PROMPT_MAX || !timezone) {
		return null;
	}
	const schedule = typeof row.schedule === "string" && row.schedule.trim() ? row.schedule.trim() : undefined;
	const every = typeof row.everyMinutes === "number" && Number.isInteger(row.everyMinutes) ? row.everyMinutes : undefined;
	if (schedule && every !== undefined) return null;
	if (schedule) {
		if (!isCronFive(schedule)) return null;
		return { name, prompt, schedule, timezone };
	}
	if (every !== undefined && every >= INTERVAL_EVERY_MINUTES_MIN && every <= INTERVAL_EVERY_MINUTES_MAX) {
		return { name, prompt, everyMinutes: every, timezone };
	}
	return null;
}

export function parseRoutineProposalCard(raw: unknown): PersistedRoutineProposalCard | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (row.v !== 1 || row.kind !== "routine-proposal") return null;
	if (typeof row.proposalId !== "string" || !row.proposalId.trim() || row.proposalId.length > 120) return null;
	if (row.mode !== "suggest" && row.mode !== "auto") return null;
	const status: RoutineProposalStatus =
		row.status === "accepted" || row.status === "declined" ? row.status : "pending";
	const spec = parseRoutineProposalSpec(row.spec);
	if (!spec) return null;
	return {
		v: 1,
		kind: "routine-proposal",
		proposalId: row.proposalId,
		mode: row.mode,
		status,
		spec,
		...(typeof row.routineId === "string" && row.routineId.trim() ? { routineId: row.routineId } : {}),
	};
}

const WEEKDAY_PHRASE: Record<string, string> = {
	domingo: "todo domingo",
	"segunda-feira": "toda segunda",
	"terça-feira": "toda terça",
	"quarta-feira": "toda quarta",
	"quinta-feira": "toda quinta",
	"sexta-feira": "toda sexta",
	sábado: "todo sábado",
};

function clockPhrase(time: string): string {
	const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return time;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, "0")}`;
}

function intervalPhrase(everyMinutes: number): string {
	if (everyMinutes === 60) return "a cada hora";
	if (everyMinutes > 60 && everyMinutes % 60 === 0) return `a cada ${everyMinutes / 60} horas`;
	return `a cada ${everyMinutes} minutos`;
}

/** "toda segunda às 8h", "nos dias úteis às 18h30", "a cada 2 horas" — para frases do card. */
export function describeRoutineProposalSchedule(spec: Pick<RoutineProposalSpec, "schedule" | "everyMinutes">): string {
	if (spec.everyMinutes !== undefined) return intervalPhrase(spec.everyMinutes);
	const cron = spec.schedule?.trim();
	if (!cron) return "em um agendamento recorrente";
	const input = cronToScheduleInput(cron);
	switch (input.frequency) {
		case "daily":
			return `todo dia às ${clockPhrase(input.time)}`;
		case "weekdays":
			return `nos dias úteis às ${clockPhrase(input.time)}`;
		case "weekly":
			return `${WEEKDAY_PHRASE[input.weekday] ?? "toda semana"} às ${clockPhrase(input.time)}`;
		case "monthly":
			return `todo dia ${input.monthDay} às ${clockPhrase(input.time)}`;
		case "hourly":
			return "a cada hora";
		case "interval": {
			const value = Number.parseInt(input.intervalValue, 10);
			if (!Number.isFinite(value) || value < 1) return "em um agendamento recorrente";
			return input.intervalUnit === "horas" ? intervalPhrase(value * 60) : intervalPhrase(value);
		}
		default:
			return "em um agendamento recorrente";
	}
}
