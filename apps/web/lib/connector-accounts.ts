import { activeT, getActiveTranslator } from "@/lib/i18n/active"
/** Várias contas do mesmo conector: apelido exibido e textos compartilhados. */

export const anotherAccountHint = () => activeT("status.accounts.hint")

type Account = { id: string; accountLabel: string | null }

/**
 * Apelido para exibir: o digitado/detectado; com várias contas e sem apelido, "Conta N" pela
 * ordem de criação (a lista já vem ordenada). Conta única sem apelido: `null`.
 */
export function accountDisplayLabel(account: Account, siblings: readonly Account[]): string | null {
  const label = account.accountLabel?.trim()
  if (label) return label
  if (siblings.length < 2) return null
  const index = siblings.findIndex((item) => item.id === account.id)
  return activeT("status.accounts.numbered", { number: (index < 0 ? siblings.length : index) + 1 })
}

/** Conta que o cartão do catálogo representa: a conectada mais antiga, senão a primeira. */
export function primaryAccount<T extends { status: string }>(accounts: readonly T[]): T | undefined {
  return accounts.find((account) => account.status === "connected") ?? accounts[0]
}

/** Agrupa contas do mesmo serviço (um cartão por serviço), na ordem da primeira ocorrência. */
export function groupAccounts<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()]
}

/** Subtítulo do cartão de um serviço com várias contas. */
export const accountCountText = (count: number) => getActiveTranslator().tn("status.accounts.count", count)
