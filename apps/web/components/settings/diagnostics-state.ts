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

export function checkLabel(check: DiagnosticsCheck): string {
  // Sem latência (null, undefined ou inválida) mostra só "ok": nunca "undefined ms".
  if (check.ok) return typeof check.ms === "number" && Number.isFinite(check.ms) ? `ok · ${check.ms} ms` : "ok"
  return check.error ? `fora · ${check.error}` : "fora"
}

export function queuesLabel(queues: DiagnosticsQueue[] | null): string {
  if (!queues) return "indisponível"
  const waiting = queues.reduce((sum, queue) => sum + queue.waiting, 0)
  const active = queues.reduce((sum, queue) => sum + queue.active, 0)
  const failed = queues.reduce((sum, queue) => sum + queue.failed, 0)
  return `${active} rodando · ${waiting} na fila${failed ? ` · ${failed} com falha` : ""}`
}

export function uptimeLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} dias`
}

export const FAILURE_KIND_LABEL: Record<DiagnosticsFailure["kind"], string> = {
  run: "Execução",
  reflection: "Reflexão",
  routine: "Rotina",
}

/** Há versões diferentes entre api, worker e web (deploy pela metade)? Só compara as conhecidas. */
export function versionMismatch(view: Pick<DiagnosticsView, "api" | "worker">, webShort: string | null): boolean {
  const known = [view.api.commitShort, view.worker.up ? view.worker.commitShort : null, webShort].filter(
    (value): value is string => Boolean(value) && value !== "dev",
  )
  return new Set(known).size > 1
}

/** Resumo do que falta no servidor (grupos não configurados), sem nomes de variáveis. */
export function missingFeaturesLabel(env: DiagnosticsView["env"]): string {
  const missing = env.filter((group) => !group.configured)
  return missing.length === 0 ? "tudo configurado" : missing.map((group) => group.label).join(", ")
}

/** Versão do web: injetada no build a partir do package.json raiz (NEXT_PUBLIC_ATLAS_VERSION). */
export function webVersion(version: string | undefined = process.env.NEXT_PUBLIC_ATLAS_VERSION): string | null {
  return version?.trim() || null
}

/** Rodapé discreto: "Versão 0.1.0-beta · abc1234" (sem a versão, só o commit). */
export function versionFooter(version: string | null | undefined, commitShort: string | null | undefined): string {
  const commit = commitShort && commitShort !== "dev" ? commitShort : ""
  if (version) return commit ? `Versão ${version} · ${commit}` : `Versão ${version}`
  return commit ? `Versão ${commit}` : ""
}
