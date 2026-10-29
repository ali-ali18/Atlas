import { ORCHESTRATOR_MEMORY_OPTIONS } from "@workspace/shared";
import type { ReflectionStatusView } from "@/lib/atlas-api";
import { formatDate, formatNumber, formatTime } from "@/lib/format";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { reflectionFailureLabel } from "@/lib/shared-labels";

type Last = NonNullable<ReflectionStatusView["last"]>;

const MINUTE = 60_000;

/** "hoje 06:02", "ontem 06:02" ou "13/10 06:02", no fuso da conta. */
export function whenLabel(iso: string, now: Date, timeZone: string, { t, locale }: Translator = defaultTranslator): string {
	const at = new Date(iso);
	const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	const hour = formatTime(at, locale, { timeZone });
	if (day(at) === day(now)) return t("settings.reflection.today", { time: hour });
	if (day(at) === day(new Date(now.getTime() - 24 * 60 * MINUTE))) return t("settings.reflection.yesterday", { time: hour });
	const date = formatDate(at, locale, { timeZone, day: "2-digit", month: "2-digit" });
	return `${date} ${hour}`;
}

/** Linha de estado sob "Refletir agora": em andamento, ou como terminou a última. */
export function reflectionStatusLabel(view: Pick<ReflectionStatusView, "active" | "last" | "timezone"> | null, now: Date = new Date(), translator: Translator = defaultTranslator): string {
	const { t } = translator;
	if (!view) return "";
	if (view.active) return t("settings.reflection.running");
	const last = view.last;
	if (!last) return t("settings.reflection.neverRan");
	const when = whenLabel(last.finishedAt ?? last.startedAt ?? now.toISOString(), now, view.timezone, translator);
	return t("settings.reflection.last", { when, outcome: outcomeLabel(last, translator) });
}

/** "falhou · <motivo curto>"; registros antigos guardavam o texto cru do erro, então cortamos. */
function failureLabel(detail: string | null, translator: Translator): string {
	const { t } = translator;
	const text = (detail ?? "").replace(/\s+/g, " ").trim();
	if (!text) return t("settings.reflection.failed");
	if (/OPENROUTER_API_KEY/i.test(text)) return t("settings.reflection.failedWith", { reason: reflectionFailureLabel("no_api_key", translator) });
	return t("settings.reflection.failedWith", { reason: text.length > 70 ? `${text.slice(0, 69).trimEnd()}…` : text });
}

function outcomeLabel(last: Last, translator: Translator): string {
	const { t, tn } = translator;
	if (last.status === "failed") return failureLabel(last.detail, translator);
	if (last.status === "skipped") return last.detail === "sem atividade nova" ? t("settings.reflection.noNews") : (last.detail ?? t("settings.reflection.ignored"));
	if (last.important) return t("settings.reflection.important");
	if (last.changeCount > 0) return tn("settings.reflection.changes", last.changeCount);
	return t("settings.reflection.nothing");
}

/** Opções do seletor de memória do bot principal, com os caracteres; um valor fora da lista aparece como Personalizado. */
export function memoryOptions(current: number, { t, locale }: Translator = defaultTranslator): Array<{ value: string; label: string }> {
	const fmt = (n: number) => formatNumber(n, locale);
	const base = ORCHESTRATOR_MEMORY_OPTIONS.map((option, index) => ({
		value: String(option.value),
		label: `${memorySizeLabel(index, option.label, t)} · ${fmt(option.value)}`,
	}));
	return base.some((option) => option.value === String(current)) ? base : [{ value: String(current), label: `${t("settings.reflection.memoryCustom")} · ${fmt(current)}` }, ...base];
}

/** Os rótulos de `shared` são pt-BR: traduz as três faixas conhecidas pela posição e mantém o texto de uma faixa nova. */
function memorySizeLabel(index: number, fallback: string, t: Translator["t"]): string {
	if (index === 0) return t("settings.reflection.memoryNormal");
	if (index === 1) return t("settings.reflection.memoryLarge");
	if (index === 2) return t("settings.reflection.memoryXLarge");
	return fallback;
}

/** "3.100 de 6.000" no idioma da tela. */
export function memoryUsageLabel(used: number, limit: number, { t, locale }: Translator = defaultTranslator): string {
	return t("settings.reflection.memoryUsage", { used: formatNumber(used, locale), limit: formatNumber(limit, locale) });
}
