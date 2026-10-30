/**
 * Rótulos de `packages/shared` no idioma da tela. O `shared` guarda o texto em pt-BR (ele também alimenta
 * prompts e o servidor), então o app traduz por id/enum com as chaves `sharedLabels.*`, sem mexer no `shared`.
 * Cada função recebe o `Translator` (padrão: o da tela, ver `i18n/active.ts`); com pt-BR devolvem o mesmo
 * texto das constantes do `shared` (um teste garante).
 */
import {
	ciCheckFailed,
	ciCheckPassed,
	type ApiAuthKind,
	type AutonomyDuration,
	type AutonomyLevel,
	type DevApprovalMode,
	type DevCiCheck,
	type DevEnvNetwork,
	type DevEnvTier,
	type DevPrState,
	type MaintenanceJobKind,
	type ModelTier,
	type ReflectionFailureCode,
} from "@workspace/shared";
import { formatDate, formatTime, toDate, type DateInput } from "./format";
import { getActiveTranslator } from "./i18n/active";
import type { MessageKey, Translator } from "./i18n/translator";

type T = Translator;
const active = getActiveTranslator;

export const autonomyLevelLabel = (level: AutonomyLevel, { t }: T = active()) => t(`sharedLabels.autonomy.level.${level}`);
export const autonomyLevelDescription = (level: AutonomyLevel, { t }: T = active()) => t(`sharedLabels.autonomy.levelDesc.${level}`);
export const autonomyDurationLabel = (duration: AutonomyDuration, { t }: T = active()) => t(`sharedLabels.autonomy.duration.${duration}`);

export const devApprovalModeLabel = (mode: DevApprovalMode, { t }: T = active()) => t(`sharedLabels.devApproval.mode.${mode}`);
export const devApprovalModeHelp = (mode: DevApprovalMode, { t }: T = active()) => t(`sharedLabels.devApproval.help.${mode}`);
export const devVerifierLabel = ({ t }: T = active()) => t("sharedLabels.devApproval.verifier");
export const devVerifierHint = ({ t }: T = active()) => t("sharedLabels.devApproval.verifierHint");
/** Vazio quando não há prefixo (como no `shared`): quem chama esconde o botão. */
export const alwaysAllowLabel = (prefixes: readonly string[], { t }: T = active()) => (prefixes.length === 0 ? "" : t("sharedLabels.devApproval.alwaysAllow"));
export const alwaysAllowDetail = (prefixes: readonly string[], { t }: T = active()) =>
	prefixes.length === 0 ? "" : t("sharedLabels.devApproval.alwaysAllowDetail", { prefixes: prefixes.join(", ") });

export const devEnvTierLabel = (tier: DevEnvTier, { t }: T = active()) => t(`sharedLabels.devEnv.tier.${tier}`);
export const devEnvNetworkLabel = (network: DevEnvNetwork, { t }: T = active()) => t(`sharedLabels.devEnv.network.${network}`);
export const modelTierLabel = (tier: ModelTier, { t }: T = active()) => t(`sharedLabels.modelTier.${tier}`);
export const devPrStateLabel = (state: DevPrState, { t }: T = active()) => t(`sharedLabels.devPr.state.${state}`);
export const apiAuthLabel = (kind: ApiAuthKind, { t }: T = active()) => t(`sharedLabels.apiAuth.${kind}`);
const MAINTENANCE_KEY = {
	summary: "sharedLabels.maintenance.summary",
	"memory-review": "sharedLabels.maintenance.memoryReview",
	reflection: "sharedLabels.maintenance.reflection",
	"connector-guide": "sharedLabels.maintenance.connectorGuide",
	reviewer: "sharedLabels.maintenance.reviewer",
	"memory-gate": "sharedLabels.maintenance.memoryGate",
	"lesson-review": "sharedLabels.maintenance.lessonReview",
	"skill-review": "sharedLabels.maintenance.skillReview",
} as const satisfies Record<MaintenanceJobKind, MessageKey>;
export const maintenanceJobLabel = (kind: MaintenanceJobKind, { t }: T = active()) => t(MAINTENANCE_KEY[kind]);
export const reflectionFailureLabel = (code: ReflectionFailureCode, { t }: T = active()) => t(`sharedLabels.reflectionFailure.${code}`);
export const decideForOtherBotsLabel = ({ t }: T = active()) => t("sharedLabels.decideForOtherBots");
export const decideForOtherBotsHint = ({ t }: T = active()) => t("sharedLabels.decideForOtherBotsHint");

/** "3 de 4 passaram" / "1 falhou · 3 de 4 passaram" (espelha `ciSummaryText` do shared). */
export function ciSummaryLabel(checks: readonly Pick<DevCiCheck, "status" | "conclusion">[], { t, tn }: T = active()): string {
	const total = checks.length;
	if (total === 0) return t("sharedLabels.ci.none");
	const passed = checks.filter(ciCheckPassed).length;
	const failed = checks.filter(ciCheckFailed).length;
	const base = tn("sharedLabels.ci.passed", passed, { passed, total });
	if (failed > 0) return `${tn("sharedLabels.ci.failed", failed)} · ${base}`;
	const running = total - passed;
	return running > 0 ? `${base} · ${t("sharedLabels.ci.running", { running })}` : base;
}

/** "Uma vez · 03/10 às 10:00" (pt) / "Once · 10/03 at 10:00 AM" (en), no fuso informado. Espelha `formatOnceSummary`. */
export function onceSummaryLabel(runAtIso: DateInput, timeZone: string, { t, locale }: T = active()): string {
	if (!toDate(runAtIso)) return t("sharedLabels.schedule.onceInvalid");
	const date = formatDate(runAtIso, locale, { day: "2-digit", month: "2-digit", timeZone });
	const time = formatTime(runAtIso, locale, { timeZone });
	return t("sharedLabels.schedule.once", { date, time });
}

/** "A cada 50 min" / "A cada 2 h" (espelha `formatIntervalSummary`; valor inválido vira "A cada —"). */
export function intervalSummaryLabel(everyMinutes: number, { t }: T = active()): string {
	if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return t("sharedLabels.schedule.everyInvalid");
	const whole = Math.trunc(everyMinutes);
	return whole % 60 === 0
		? t("sharedLabels.schedule.everyHours", { count: whole / 60 })
		: t("sharedLabels.schedule.everyMinutes", { count: whole });
}
