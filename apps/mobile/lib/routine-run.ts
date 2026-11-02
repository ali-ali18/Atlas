import { describeRoutineFailure, type RoutineRunRecord } from "@workspace/shared";

// Linhas do histórico de execuções da rotina, iguais às do web (`routineRunLabel`): "cron · concluída",
// "manual · falhou · sem créditos no provedor do modelo". Lógica pura, só pt-BR.

// Origem em palavras do usuário (o web mostra "cron" e "webhook"; aqui nada de termo técnico).
const VIA: Record<RoutineRunRecord["triggeredBy"], string> = { event: "por evento", manual: "manual", schedule: "agendada" };
const STATUS: Record<RoutineRunRecord["status"], string> = { queued: "na fila", running: "executando", succeeded: "concluída", skipped: "pulada", failed: "falhou" };

/** Motivo curto de uma falha ("sem créditos no provedor do modelo"), sem segredo; frase do próprio sistema vale como está. */
export function failureReason(error: string | null | undefined): string {
	const { headline } = describeRoutineFailure(error);
	return headline.charAt(0).toLowerCase() + headline.slice(1);
}

export function routineRunLabel(run: Pick<RoutineRunRecord, "status" | "error" | "triggeredBy">): string {
	const base = `${VIA[run.triggeredBy] ?? "agendada"} · ${STATUS[run.status] ?? STATUS.failed}`;
	if (run.status === "skipped" && run.error) return `${base} · ${describeRoutineFailure(run.error).headline}`;
	if (run.status === "failed" && run.error) return `${base} · ${failureReason(run.error)}`;
	return base;
}

/** "03/10 10:00" no fuso dado (o do aparelho por padrão). */
export function formatRunTime(iso: string, timeZone?: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const parts = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}
