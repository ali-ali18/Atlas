import {
	PROACTIVE_MAX_PER_DAY_MAX,
	PROACTIVE_MAX_PER_DAY_MIN,
	isValidTimeZone,
	parseClockMinutes,
	readProactiveSettings,
	withProactiveSettings,
	type ProactiveRoutineMode,
	type ProactiveSettings,
} from "@workspace/shared";

export const ROUTINE_MODE_OPTIONS: ReadonlyArray<{ value: ProactiveRoutineMode; label: string; hint: string }> = [
	{ value: "suggest", label: "Sugerir", hint: "O bot mostra um card e você escolhe criar a rotina." },
	{ value: "auto", label: "Automático", hint: "O bot cria a rotina e avisa; você pode desfazer." },
];

export const MAX_PER_DAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Array.from(
	{ length: PROACTIVE_MAX_PER_DAY_MAX - PROACTIVE_MAX_PER_DAY_MIN + 1 },
	(_, index) => {
		const value = String(PROACTIVE_MAX_PER_DAY_MIN + index);
		return { value, label: value };
	},
);

/** Fuso do navegador (o do usuário); `undefined` quando indisponível ou inválido. */
export function browserTimeZone(): string | undefined {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimeZone(zone) ? zone : undefined;
	} catch {
		return undefined;
	}
}

/** O modo só se mexe no bot principal. */
export function proactiveAvailable(agent: { isPrimary?: boolean }): boolean {
	return agent.isPrimary === true;
}

export type ProactiveChange =
	| { type: "enabled"; value: boolean }
	| { type: "routineMode"; value: ProactiveRoutineMode }
	| { type: "maxPerDay"; value: number }
	| { type: "quiet"; start?: string; end?: string };

/**
 * Novo `policyJson` do bot depois de uma mudança no painel. Ligar sincroniza o fuso com o do
 * navegador; horário inválido (campo vazio durante a digitação) é ignorado.
 */
export function applyProactiveChange(
	policyJson: unknown,
	change: ProactiveChange,
	timeZone: string | undefined = browserTimeZone(),
): Record<string, unknown> {
	const patch: Partial<ProactiveSettings> = {};
	if (change.type === "enabled") {
		patch.enabled = change.value;
		if (change.value && timeZone && isValidTimeZone(timeZone)) patch.timezone = timeZone;
	} else if (change.type === "routineMode") {
		patch.routineMode = change.value;
	} else if (change.type === "maxPerDay") {
		patch.maxPerDay = change.value;
	} else {
		if (change.start !== undefined && parseClockMinutes(change.start) !== null) patch.quietStart = change.start;
		if (change.end !== undefined && parseClockMinutes(change.end) !== null) patch.quietEnd = change.end;
	}
	return withProactiveSettings(policyJson, patch);
}

export { readProactiveSettings };
