import { cronToScheduleInput, formatIntervalSummary, formatOnceSummary, type RoutineGroupRecord, type RoutineRecord } from "@workspace/shared";

// Frases das rotinas na tela do app: o mesmo texto do web (`routineScheduleSummary`, `routineGroupSummary`), só pt-BR.
// Lógica pura, com `now` fora; o componente só desenha.

const capitalize = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** Frase do agendamento por cron ("Nos dias úteis às 9:00"); cron que não dá para ler vira "Em um agendamento" (nunca o cron cru). */
export function cronSentence(cron: string): string {
	const state = cronToScheduleInput(cron);
	switch (state.frequency) {
		case "hourly":
			return `A cada hora aos ${state.minute}`;
		case "weekdays":
			return `Nos dias úteis às ${state.time}`;
		case "weekly":
			return `A cada ${state.weekday} às ${state.time}`;
		case "monthly":
			return `Todo dia ${state.monthDay} às ${state.time}`;
		case "interval":
			return `A cada ${state.intervalValue} ${state.intervalUnit}`;
		case "daily":
			return `Todos os dias às ${state.time}`;
		default:
			return "Em um agendamento";
	}
}

/** Resumo de quando a rotina roda ("Uma vez · 03/10 às 10:00", "A cada 50 min", "Por evento", "GitHub · org/repo"). */
export function routineSummary(routine: RoutineRecord): string {
	if (routine.triggerType === "once" && routine.once) return formatOnceSummary(routine.once.runAt, routine.timezone || undefined);
	if (routine.triggerType === "interval" && routine.interval) return formatIntervalSummary(routine.interval.everyMinutes);
	if (routine.triggerType === "event") {
		if (routine.github) {
			const repo = routine.github.repo.trim();
			return repo ? `GitHub · ${repo}` : "GitHub";
		}
		if (routine.email) return "Quando chega e-mail";
		return "Por evento";
	}
	if (routine.triggerType === "cron" && routine.schedule) return capitalize(cronSentence(routine.schedule));
	return "Sem gatilho";
}

/** "2 de 3 ativas" / "1 de 1 ativa". */
export function groupSummary(active: number, count: number): string {
	return `${active} de ${count} ${count === 1 ? "ativa" : "ativas"}`;
}

export type RoutineListEntry = { kind: "routine"; routine: RoutineRecord } | { kind: "group"; group: RoutineGroupRecord; routines: RoutineRecord[] };

/** Lista da tela: rotinas soltas (na ordem recebida) e grupos; grupos sem rotina vão ao fim, como no web. */
export function groupRoutines(routines: readonly RoutineRecord[], groups: readonly RoutineGroupRecord[]): RoutineListEntry[] {
	const known = new Set(groups.map((group) => group.id));
	const entries: RoutineListEntry[] = [];
	const placed = new Set<string>();
	for (const routine of routines) {
		if (routine.groupId && known.has(routine.groupId)) {
			if (placed.has(routine.groupId)) continue;
			placed.add(routine.groupId);
			const group = groups.find((item) => item.id === routine.groupId)!;
			entries.push({ kind: "group", group, routines: routines.filter((item) => item.groupId === group.id) });
		} else entries.push({ kind: "routine", routine });
	}
	for (const group of groups) if (!placed.has(group.id)) entries.push({ kind: "group", group, routines: [] });
	return entries;
}
