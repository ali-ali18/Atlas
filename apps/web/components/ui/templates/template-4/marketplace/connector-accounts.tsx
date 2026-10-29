"use client"

import { useState, type FormEvent } from "react"
import { CheckIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react"
import { ACCOUNT_LABEL_MAX_CHARS } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { cn } from "@workspace/ui/lib/utils"
import { anotherAccountHint } from "@/lib/connector-accounts"
import { useTranslations } from "@/lib/i18n/provider"

export type AccountRow = {
  id: string
  /** Apelido da conta (ou o nome do serviço quando só existe uma, sem apelido). */
  title: string
  /** Estado em uma linha ("Conectada", "Login pendente"…). */
  status: string
  ok: boolean
  /** Mostra "Reconectar" nesta linha (login expirado). */
  needsReconnect?: boolean
  /** Linha atualmente aberta na página (destaque). */
  current?: boolean
  /** Apelido digitável (vazio quando a conta ainda não tem). */
  label: string
}

/**
 * Seção "Contas" da página de um conector: uma linha por conta (apelido, estado, renomear,
 * reconectar, desconectar) e o botão "Adicionar outra conta". Igual para MCP e para API.
 */
export function AccountsSection({
  accounts,
  busyId,
  adding = false,
  oauthHint = false,
  error,
  onSelect,
  onRename,
  onReconnect,
  onDisconnect,
  onAdd,
}: {
  accounts: AccountRow[]
  busyId?: string | null
  adding?: boolean
  /** Mostra o aviso de "sair da conta atual" (conectores com login por navegador). */
  oauthHint?: boolean
  error?: string | null
  /** Abre/seleciona a conta; sem isso a linha não é clicável. */
  onSelect?: (id: string) => void
  onRename: (id: string, label: string) => Promise<void> | void
  onReconnect?: (id: string) => void
  onDisconnect: (id: string) => Promise<void> | void
  onAdd: () => void
}) {
  const { t } = useTranslations()
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    const { id, value } = editing
    setEditing(null)
    await onRename(id, value.trim())
  }

  return (
    <section aria-label={t("marketplace.accounts.section")} className="space-y-2">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-sm font-semibold">
          {t("marketplace.accounts.section")} <span className="font-normal text-muted-foreground">{accounts.length}</span>
        </h3>
        <Button className="h-7 rounded-full px-3 text-xs" disabled={adding} onClick={onAdd} size="sm" type="button" variant="secondary">
          <PlusIcon aria-hidden className="size-3.5" />
          {adding ? t("marketplace.accounts.connecting") : t("marketplace.accounts.addAnother")}
        </Button>
      </div>
      <ul className="m-0 list-none divide-y rounded-xl border bg-muted/20 p-0">
        {accounts.map((account) => {
          const busy = busyId === account.id
          const isEditing = editing?.id === account.id
          return (
            <li className={cn("min-w-0", account.current && "bg-muted/40 first:rounded-t-xl last:rounded-b-xl")} key={account.id}>
              {isEditing ? (
                <form className="flex min-h-14 min-w-0 items-center gap-2 px-4 py-2.5" onSubmit={(event) => void save(event)}>
                  <Input
                    aria-label={t("marketplace.accounts.nickname")}
                    autoFocus
                    className="h-8 min-w-0 flex-1"
                    maxLength={ACCOUNT_LABEL_MAX_CHARS}
                    onChange={(event) => setEditing({ id: account.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(null)
                    }}
                    placeholder={t("marketplace.accounts.nicknamePlaceholder")}
                    value={editing.value}
                  />
                  <Button aria-label={t("marketplace.accounts.saveNickname")} className="shrink-0" size="icon-sm" type="submit" variant="ghost">
                    <CheckIcon />
                  </Button>
                  <Button aria-label={t("common.cancel")} className="shrink-0" onClick={() => setEditing(null)} size="icon-sm" type="button" variant="ghost">
                    <XIcon />
                  </Button>
                </form>
              ) : (
                <div className="flex min-h-14 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5">
                  {onSelect ? (
                    <button
                      aria-current={account.current ? "true" : undefined}
                      className="min-w-32 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      onClick={() => onSelect(account.id)}
                      type="button"
                    >
                      <AccountText account={account} />
                    </button>
                  ) : (
                    <div className="min-w-32 flex-1">
                      <AccountText account={account} />
                    </div>
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button
                      aria-label={t("marketplace.accounts.rename", { name: account.title })}
                      disabled={busy}
                      onClick={() => setEditing({ id: account.id, value: account.label })}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <PencilIcon />
                    </Button>
                    {account.needsReconnect && onReconnect ? (
                      <Button className="h-7 rounded-full px-3 text-xs" disabled={busy} onClick={() => onReconnect(account.id)} size="sm" type="button" variant="secondary">
                        {t("marketplace.accounts.reconnect")}
                      </Button>
                    ) : null}
                    <Button
                      aria-label={t("marketplace.accounts.disconnectNamed", { name: account.title })}
                      className="h-7 rounded-full px-3 text-xs"
                      disabled={busy}
                      onBlur={() => setConfirming((current) => (current === account.id ? null : current))}
                      onClick={() => {
                        if (confirming === account.id) {
                          setConfirming(null)
                          void onDisconnect(account.id)
                        } else setConfirming(account.id)
                      }}
                      size="sm"
                      type="button"
                      variant={confirming === account.id ? "destructive" : "ghost"}
                    >
                      {confirming === account.id ? t("marketplace.accounts.confirm") : t("marketplace.accounts.disconnect")}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {error ? (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {oauthHint ? <p className="m-0 pt-1 text-xs text-muted-foreground">{anotherAccountHint()}</p> : null}
    </section>
  )
}

function AccountText({ account }: { account: AccountRow }) {
  return (
    <>
      <span className="block truncate text-sm font-medium">{account.title}</span>
      <span className={cn("block truncate text-xs", account.ok ? "text-muted-foreground" : "text-warning")}>{account.status}</span>
    </>
  )
}

/** Seletor segmentado de conta (mesmo controle das abas do Marketplace): troca a conta mostrada abaixo. */
export function AccountTabs({
  accounts,
  value,
  onChange,
  label,
}: {
  accounts: { id: string; title: string }[]
  value: string | undefined
  onChange: (id: string) => void
  label?: string
}) {
  const { t } = useTranslations()
  return (
    <Tabs onValueChange={onChange} value={value}>
      <TabsList aria-label={label ?? t("marketplace.accounts.tabsLabel")} className="max-w-full">
        {accounts.map((account) => (
          <TabsTrigger className="min-w-0 max-w-40 px-3" key={account.id} value={account.id}>
            <span className="truncate">{account.title}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
