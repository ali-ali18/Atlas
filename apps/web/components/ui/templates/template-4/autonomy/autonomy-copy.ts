import type { AutonomyDuration, AutonomyExceptionMode, AutonomyLevel } from "@workspace/shared";

import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/**
 * Textos da Autonomia no idioma da tela. `packages/shared` guarda os rótulos em pt-BR (servem também ao
 * prompt e ao card do chat); a interface monta os dela daqui, com as chaves `autonomy.*`.
 */
export function levelLabel(level: AutonomyLevel, { t }: Translator = defaultTranslator): string {
	return t(`autonomy.level.${level}`);
}

export function levelDescription(level: AutonomyLevel, { t }: Translator = defaultTranslator): string {
	return t(`autonomy.levelDescription.${level}`);
}

export function durationLabel(duration: AutonomyDuration, { t }: Translator = defaultTranslator): string {
	return t(`autonomy.duration.${duration}`);
}

export function modeLabel(mode: AutonomyExceptionMode, { t }: Translator = defaultTranslator): string {
	return t(`autonomy.mode.${mode}`);
}

/** "6 dias", "5 horas", "menos de 1 hora" (mesma conta de `formatAutonomyRemaining` do shared). */
export function remainingLabel(until: string, now: Date, { t, tn }: Translator = defaultTranslator): string {
	const ms = Date.parse(until) - now.getTime();
	const hours = ms / 3_600_000;
	if (!Number.isFinite(ms) || hours < 1) return t("autonomy.remaining.lessThanHour");
	if (hours < 24) return tn("autonomy.remaining.hours", Math.ceil(hours));
	return tn("autonomy.remaining.days", Math.ceil(hours / 24));
}

const HOST_TOOLS = ["propose_profile_update", "propose_skill_delete"] as const;
type HostTool = (typeof HOST_TOOLS)[number];

function isHostTool(tool: string): tool is HostTool {
	return (HOST_TOOLS as readonly string[]).includes(tool);
}

/** Rótulo de uma tool própria do agente no idioma da tela; `undefined` para as de conector. */
export function hostToolLabel(tool: string, { t }: Translator = defaultTranslator): string | undefined {
	return isHostTool(tool) ? t(`autonomy.hostTool.${tool}`) : undefined;
}
