import { formatDateTime } from "@/lib/format"
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales"
import { defaultTranslator, type Translator } from "@/lib/i18n/translator"
import type { DiagnosticsCheck, DiagnosticsFailure, DiagnosticsQueue, DiagnosticsView } from "@workspace/shared"

/** "abc1234", ou "" quando o build não achou o commit. */
export function commitLabel(commitShort: string | null | undefined): string {
  return commitShort && commitShort !== "dev" ? commitShort : ""
}

/** Versão do web: injetada no build (NEXT_PUBLIC_ATLAS_COMMIT). */
export function webCommitShort(commit: string | undefined = process.env.NEXT_PUBLIC_ATLAS_COMMIT): string | null {
  const text = commit?.trim()
  if (!text) return null
  return /^[0-9a-f]{12,40}$/i.test(text) ? text.slice(0, 7) : text
}

export function checkLabel(check: DiagnosticsCheck, { t }: Translator = defaultTranslator): string {
  // Sem latência (null, undefined ou inválida) mostra só "ok": nunca "undefined ms".
  if (check.ok) return typeof check.ms === "number" && Number.isFinite(check.ms) ? t("settings.diag.checkOk", { ms: check.ms }) : t("settings.diag.checkOkPlain")
  return check.error ? t("settings.diag.checkDownWith", { error: check.error }) : t("settings.diag.checkDown")
}

export function queuesLabel(queues: DiagnosticsQueue[] | null, { t }: Translator = defaultTranslator): string {
  if (!queues) return t("settings.diag.queuesUnavailable")
  const waiting = queues.reduce((sum, queue) => sum + queue.waiting, 0)
  const active = queues.reduce((sum, queue) => sum + queue.active, 0)
  const failed = queues.reduce((sum, queue) => sum + queue.failed, 0)
  return failed ? t("settings.diag.queuesLineFailed", { active, waiting, failed }) : t("settings.diag.queuesLine", { active, waiting })
}

export function uptimeLabel(seconds: number, { t }: Translator = defaultTranslator): string {
  if (seconds < 60) return t("settings.diag.uptimeSeconds", { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t("settings.diag.uptimeMinutes", { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t("settings.diag.uptimeHours", { n: hours })
  return t("settings.diag.uptimeDays", { n: Math.floor(hours / 24) })
}

const FAILURE_KIND_KEYS = {
  run: "settings.diag.failureKind.run",
  reflection: "settings.diag.failureKind.reflection",
  routine: "settings.diag.failureKind.routine",
} as const satisfies Record<DiagnosticsFailure["kind"], string>

export function failureKindLabel(kind: DiagnosticsFailure["kind"], { t }: Translator = defaultTranslator): string {
  return t(FAILURE_KIND_KEYS[kind])
}

/** Há versões diferentes entre api, worker e web (deploy pela metade)? Só compara as conhecidas. */
export function versionMismatch(view: Pick<DiagnosticsView, "api" | "worker">, webShort: string | null): boolean {
  const known = [view.api.commitShort, view.worker.up ? view.worker.commitShort : null, webShort].filter(
    (value): value is string => Boolean(value) && value !== "dev",
  )
  return new Set(known).size > 1
}

/** Resumo do que falta no servidor (grupos não configurados), sem nomes de variáveis. */
export function missingFeaturesLabel(env: DiagnosticsView["env"], { t }: Translator = defaultTranslator): string {
  const missing = env.filter((group) => !group.configured)
  return missing.length === 0 ? t("settings.diag.allConfigured") : missing.map((group) => group.label).join(", ")
}

/** Versão do web: injetada no build a partir do package.json raiz (NEXT_PUBLIC_ATLAS_VERSION). */
export function webVersion(version: string | undefined = process.env.NEXT_PUBLIC_ATLAS_VERSION): string | null {
  return version?.trim() || null
}

/** Rodapé discreto: "Versão 0.1.0-beta · abc1234" (sem a versão, só o commit). */
export function versionFooter(version: string | null | undefined, commitShort: string | null | undefined, { t }: Translator = defaultTranslator): string {
  const commit = commitShort && commitShort !== "dev" ? commitShort : ""
  if (version) return commit ? `${t("settings.diag.version", { version })} · ${commit}` : t("settings.diag.version", { version })
  return commit ? t("settings.diag.version", { version: commit }) : ""
}

/** Data curta (dia/mês hora:minuto) das tarefas em segundo plano. */
export function maintenanceTime(iso: string, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	return formatDateTime(iso, locale);
}

/** Texto do último sucesso de uma tarefa: horário, ou "nunca rodou com sucesso". */
export function maintenanceSuccessLabel(lastSuccessAt: string | null, translator: Translator = defaultTranslator): string {
	return lastSuccessAt ? translator.t("settings.diag.lastSuccess", { time: maintenanceTime(lastSuccessAt, translator.locale) }) : translator.t("settings.diag.noSuccess");
}

const JOB_KEYS = {
	summary: "settings.diag.job.summary",
	"memory-review": "settings.diag.job.memoryReview",
	reflection: "settings.diag.job.reflection",
	"connector-guide": "settings.diag.job.connectorGuide",
	reviewer: "settings.diag.job.reviewer",
	"memory-gate": "settings.diag.job.memoryGate",
	"lesson-review": "settings.diag.job.lessonReview",
	"skill-review": "settings.diag.job.skillReview",
} as const;

/** Nome da tarefa em segundo plano no idioma da tela (o rótulo de `shared` é só pt-BR). */
export function maintenanceJobLabel(kind: keyof typeof JOB_KEYS, { t }: Translator = defaultTranslator): string {
	return t(JOB_KEYS[kind]);
}
