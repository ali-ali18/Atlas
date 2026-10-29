import type { CatalogInstallView } from "@/lib/atlas-api"
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales"

/** Estado puro do marketplace de skills e agentes (lista, filtros, rótulos). Sem React. */

export const CATEGORY_LABELS: Record<string, string> = {
  games: "Jogos",
  dev: "Desenvolvimento",
  productivity: "Produtividade",
  research: "Pesquisa",
  writing: "Escrita",
  data: "Dados",
  geral: "Geral",
}

export function categoryLabel(id: string): string {
  const known = CATEGORY_LABELS[id]
  if (known) return known
  const text = id.replace(/-/g, " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Nomes amigáveis das dicas de ferramenta (a skill nunca concede permissão a nenhuma). */
export const TOOL_LABELS: Record<string, string> = {
  shell: "Terminal da VM",
  secret_list: "Nomes do cofre",
  secret_request: "Pedir segredo",
  propose_questionnaire: "Fazer perguntas",
  github: "GitHub",
  calendar: "Agenda",
}

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

type Searchable = {
  name: string
  description: string
  author: string
  category: string
  tags: readonly string[]
}

function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

export function filterCatalogItems<T extends Searchable>(
  items: readonly T[],
  query: string,
  category: string
): T[] {
  const term = plain(query.trim())
  return items.filter((item) => {
    if (category && item.category !== category) return false
    if (!term) return true
    return plain(
      `${item.name} ${item.description} ${item.author} ${item.tags.join(" ")} ${categoryLabel(item.category)}`
    ).includes(term)
  })
}

export function categoriesOf(
  items: readonly Pick<Searchable, "category">[],
  locale: UiLocale = DEFAULT_UI_LOCALE
): Array<{ id: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
}

export type InstallSummary =
  | { kind: "none" }
  | { kind: "installed"; version: string; count: number }
  | { kind: "update"; installed: string; edited: boolean; count: number }

/** Resumo para o cartão/página: nada instalado, em dia ou com atualização disponível. */
export function installSummary(installs: readonly CatalogInstallView[]): InstallSummary {
  if (installs.length === 0) return { kind: "none" }
  const pending = installs.find((item) => item.updateAvailable)
  if (pending) {
    return {
      kind: "update",
      installed: pending.version,
      edited: installs.some((item) => item.updateAvailable && item.edited),
      count: installs.length,
    }
  }
  return { kind: "installed", version: installs[0]?.version ?? "", count: installs.length }
}

export type ScopeOption = { id: string | null; label: string; hint?: string }

/** Onde instalar: conta (todos os agentes) ou um agente específico. */
export function scopeOptions(
  bots: ReadonlyArray<{ id: string; name: string }>,
  installs: readonly CatalogInstallView[]
): ScopeOption[] {
  const taken = new Set(installs.map((item) => item.botId))
  return [
    {
      id: null,
      label: "Minha conta",
      hint: taken.has(null) ? "Já instalada aqui" : "Todos os seus agentes podem usar",
    },
    ...bots.map((bot) => ({
      id: bot.id,
      label: bot.name,
      ...(taken.has(bot.id) ? { hint: "Já instalada aqui" } : {}),
    })),
  ]
}

export function diffLabel(added: number, removed: number): string {
  const plus = `${added} ${added === 1 ? "linha nova" : "linhas novas"}`
  const minus = `${removed} ${removed === 1 ? "removida" : "removidas"}`
  return `${plus} · ${minus}`
}

/** "ferramentas, util" -> ["ferramentas", "util"] (slug, sem repetir, até 10). */
export function parseTagInput(raw: string): string[] {
  const tags: string[] = []
  for (const part of raw.split(/[,\n]/)) {
    const tag = plain(part)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags.slice(0, 10)
}

/** Próxima versão sugerida (patch) a partir da instalada, ou 1.0.0 para skill nova. */
export function suggestVersion(current: string | null | undefined): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current ?? "")
  if (!match) return "1.0.0"
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

export type Connectable = { id: string; reason?: string; connected: boolean }

export function connectorStatusLabel(connected: boolean): string {
  return connected ? "Conectado" : "Conectar depois"
}
