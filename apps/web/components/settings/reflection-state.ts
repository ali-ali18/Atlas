import { ORCHESTRATOR_MEMORY_OPTIONS, REFLECTION_FAILURE_LABELS } from "@workspace/shared";
import type { ReflectionStatusView } from "@/lib/atlas-api";

type Last = NonNullable<ReflectionStatusView["last"]>;

const MINUTE = 60_000;

/** "hoje 06:02", "ontem 06:02" ou "13/10 06:02", no fuso da conta. */
export function whenLabel(iso: string, now: Date, timeZone: string): string {
	const at = new Date(iso);
	const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	const hour = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
	if (day(at) === day(now)) return `hoje ${hour}`;
	if (day(at) === day(new Date(now.getTime() - 24 * 60 * MINUTE))) return `ontem ${hour}`;
	const date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(at);
	return `${date} ${hour}`;
}

/** Linha de estado sob "Refletir agora": em andamento, ou como terminou a última. */
export function reflectionStatusLabel(view: Pick<ReflectionStatusView, "active" | "last" | "timezone"> | null, now: Date = new Date()): string {
	if (!view) return "";
	if (view.active) return "Refletindo agora…";
	const last = view.last;
	if (!last) return "Ainda não rodou.";
	const when = whenLabel(last.finishedAt ?? last.startedAt ?? now.toISOString(), now, view.timezone);
	return `Última: ${when} · ${outcomeLabel(last)}`;
}

/** "falhou · <motivo curto>"; registros antigos guardavam o texto cru do erro, então cortamos. */
function failureLabel(detail: string | null): string {
	const text = (detail ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "falhou";
	if (/OPENROUTER_API_KEY/i.test(text)) return `falhou · ${REFLECTION_FAILURE_LABELS.no_api_key}`;
	return `falhou · ${text.length > 70 ? `${text.slice(0, 69).trimEnd()}…` : text}`;
}

function outcomeLabel(last: Last): string {
	if (last.status === "failed") return failureLabel(last.detail);
	if (last.status === "skipped") return last.detail === "sem atividade nova" ? "sem novidades" : (last.detail ?? "ignorada");
	if (last.important) return "achou algo importante";
	if (last.changeCount > 0) return `${last.changeCount} ${last.changeCount === 1 ? "alteração" : "alterações"}`;
	return "nada relevante";
}

/** Opções do seletor de memória do bot principal, com os caracteres; um valor fora da lista aparece como Personalizado. */
export function memoryOptions(current: number): Array<{ value: string; label: string }> {
	const fmt = (n: number) => new Intl.NumberFormat("pt-BR").format(n);
	const base = ORCHESTRATOR_MEMORY_OPTIONS.map((option) => ({ value: String(option.value), label: `${option.label} · ${fmt(option.value)}` }));
	return base.some((option) => option.value === String(current)) ? base : [{ value: String(current), label: `Personalizado · ${fmt(current)}` }, ...base];
}
