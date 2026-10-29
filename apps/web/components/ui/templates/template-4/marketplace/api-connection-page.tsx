"use client"

import { ConnectorGuide } from "./connector-guide"
import { useEffect, useMemo, useState } from "react"
import { ChevronRightIcon, SearchIcon } from "lucide-react"
import type { ApiConnectionView, ApiOperation } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workspace/ui/components/input-group"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon"
import { listApiOperations } from "@/lib/atlas-api"
import { accountDisplayLabel } from "@/lib/connector-accounts"
import { AccountTabs, AccountsSection } from "./connector-accounts"
import { apiOperationGuide, ToolGuide } from "./tool-guide"
import { apiAccessSummary, apiConnectionStatusLabel, readableApiGroups } from "./api-connections-section"
import { apiAuthLabel } from "@/lib/shared-labels"
import { useTranslations } from "@/lib/i18n/provider"

/** Detalhe de uma API conectada (subpágina do Marketplace): resumo, reconectar/desconectar e grupos liberados. */
/** Contas da mesma API (mesma base): a seção "Contas" da página. */
export type ApiAccountsProps = {
  items: ApiConnectionView[]
  adding?: boolean
  error?: string | null
  onAdd: () => void
  /** Abre a página de outra conta. */
  onOpen: (id: string) => void
  onRename: (id: string, label: string) => void
  onRemove: (id: string) => void
}

export function ApiConnectionPage({
  item,
  accounts,
  busyId,
  busy,
  error,
  onReconnect,
  onRemove,
  onSaveGroups,
  loadOperations = listApiOperations,
}: {
  item: ApiConnectionView
  busy: boolean
  error?: string | null
  /** Seção "Contas" (adicionar outra conta, renomear, desconectar por conta). */
  accounts?: ApiAccountsProps
  busyId?: string | null
  onReconnect: (input?: { apiKey?: string }) => void
  onRemove: () => void
  onSaveGroups: (tags: string[]) => void
  /** Operações do catálogo (guia de cada consulta); carregadas ao abrir o primeiro grupo. */
  loadOperations?: (id: string) => Promise<ApiOperation[]>
}) {
  const translator = useTranslations()
  const { t, tn } = translator
  const [keyOpen, setKeyOpen] = useState(false)
  const [apiKey, setApiKey] = useState("")
  // Desconectar apaga a conexão e as credenciais: pede um segundo toque.
  const [confirming, setConfirming] = useState(false)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [operations, setOperations] = useState<ApiOperation[] | "error" | null>(null)
  const [guide, setGuide] = useState<ApiOperation | null>(null)
  useEffect(() => {
    if (expanded === null || operations !== null) return
    let alive = true
    loadOperations(item.id).then(
      (list) => alive && setOperations(list),
      () => alive && setOperations("error")
    )
    return () => {
      alive = false
    }
  }, [expanded, operations, item.id, loadOperations])
  const connected = item.status === "connected"
  const siblings = accounts?.items ?? [item]
  const accountLabel = siblings.length > 1 ? accountDisplayLabel(item, siblings) : item.accountLabel
  const needsKey = item.authKind === "apiKey" || item.authKind === "bearer"
  const readable = useMemo(() => readableApiGroups(item), [item])
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? readable.filter((group) => group.tag.toLowerCase().includes(term)) : readable
  }, [readable, query])
  const toggle = (tag: string, on: boolean) =>
    onSaveGroups(on ? [...item.allowedTags, tag] : item.allowedTags.filter((value) => value !== tag))

  return (
    <div className="min-w-0 space-y-6 pb-2">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl border bg-background">
          <CustomMcpIcon className="size-8" name={item.name} url={item.baseUrl} />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <h2 className="truncate text-xl font-semibold">{item.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {accountLabel ? `${accountLabel} · ` : ""}
            <span className="font-mono">{item.domain}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">
          {!connected ? (
            <Button
              disabled={busy}
              onClick={() => (needsKey ? setKeyOpen((value) => !value) : onReconnect())}
              type="button"
            >
              {busy ? t("marketplace.action.connecting") : t("marketplace.action.reconnect")}
            </Button>
          ) : null}
          {accounts ? null : (
            <Button
              disabled={busy}
              onBlur={() => setConfirming(false)}
              onClick={() => (confirming ? onRemove() : setConfirming(true))}
              type="button"
              variant={confirming ? "destructive" : "secondary"}
            >
              {confirming ? t("marketplace.api.confirm") : t("marketplace.api.disconnect")}
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {keyOpen && !connected ? (
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!apiKey.trim()) return
            onReconnect({ apiKey: apiKey.trim() })
            setApiKey("")
            setKeyOpen(false)
          }}
        >
          <Input
            aria-label={item.authKind === "bearer" ? t("marketplace.api.newToken") : t("marketplace.api.newKey")}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={item.authKind === "bearer" ? t("marketplace.api.newTokenPlaceholder") : t("marketplace.api.newKeyPlaceholder")}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
          <Button disabled={busy || !apiKey.trim()} type="submit">
            {t("common.save")}
          </Button>
        </form>
      ) : null}

      {accounts ? (
        <AccountsSection
          accounts={siblings.map((account) => {
            const label = accountDisplayLabel(account, siblings)
            return {
              id: account.id,
              title: label ?? account.name,
              status: apiConnectionStatusLabel(account, translator),
              ok: account.status === "connected",
              needsReconnect: account.status !== "connected",
              current: account.id === item.id,
              label: account.accountLabel ?? "",
            }
          })}
          adding={accounts.adding}
          busyId={busyId}
          error={accounts.error}
          oauthHint={item.authKind === "oauth2"}
          onAdd={accounts.onAdd}
          onDisconnect={(id) => accounts.onRemove(id)}
          onReconnect={(id) => (id === item.id ? (needsKey ? setKeyOpen(true) : onReconnect()) : accounts.onOpen(id))}
          onRename={(id, label) => accounts.onRename(id, label)}
          onSelect={siblings.length > 1 ? accounts.onOpen : undefined}
        />
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("marketplace.api.summary")}</h3>
        <dl className="m-0 divide-y rounded-xl border bg-muted/20 px-4">
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="shrink-0 text-muted-foreground">{t("marketplace.api.address")}</dt>
            <dd className="m-0 min-w-0 break-all text-right font-mono text-xs leading-5">{item.baseUrl}</dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="text-muted-foreground">{t("marketplace.api.authentication")}</dt>
            <dd className="m-0">{apiAuthLabel(item.authKind, translator)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="shrink-0 text-muted-foreground">{t("marketplace.api.state")}</dt>
            <dd
              className={cn(
                "m-0 min-w-0 text-right",
                connected ? "text-success" : "text-warning"
              )}
            >
              {apiConnectionStatusLabel(item, translator)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="text-muted-foreground">{t("marketplace.api.access")}</dt>
            <dd className="m-0">{apiAccessSummary(item, translator)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold">
            {t("marketplace.api.groups")}{" "}
            <span className="font-normal text-muted-foreground">
              {t("marketplace.api.groupsCount", { allowed: item.allowedTags.length, total: readable.length })}
            </span>
          </h3>
          {accounts && siblings.length > 1 ? (
            <AccountTabs
              accounts={siblings.map((account) => ({ id: account.id, title: accountDisplayLabel(account, siblings) ?? account.name }))}
              label={t("marketplace.api.accountInSetup")}
              onChange={accounts.onOpen}
              value={item.id}
            />
          ) : null}
          <div aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground">
            {busy ? <span className="mr-1">{t("marketplace.api.saving")}</span> : null}
            <Button
              className="h-7 rounded-full px-3 text-xs"
              disabled={busy || item.allowedTags.length === readable.length}
              onClick={() => onSaveGroups(readable.map((group) => group.tag))}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("marketplace.api.allowAll")}
            </Button>
            <Button
              className="-mr-3 h-7 rounded-full px-3 text-xs"
              disabled={busy || item.allowedTags.length === 0}
              onClick={() => onSaveGroups([])}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("marketplace.api.allowNone")}
            </Button>
          </div>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("marketplace.api.searchGroup")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("marketplace.api.searchGroup")}
            value={query}
          />
        </InputGroup>
        {visible.length > 0 ? (
          <ul aria-label={t("marketplace.api.allowedGroups")} className="m-0 list-none divide-y rounded-xl border bg-muted/20 p-0">
            {visible.map((group) => {
              const id = `api-group-${item.id}-${group.tag}`
              const open = expanded === group.tag
              const ops = Array.isArray(operations) ? operations.filter((operation) => operation.tag === group.tag) : []
              return (
                <li className="min-w-0" key={group.tag}>
                  <div className="flex min-h-14 min-w-0 items-center gap-4 px-4 py-2.5">
                    <button
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      onClick={() => setExpanded(open ? null : group.tag)}
                      type="button"
                    >
                      <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium" id={`${id}-nome`}>
                          {group.tag}
                        </span>
                        <span className="block text-xs text-muted-foreground">{tn("marketplace.api.queries", group.read)}</span>
                      </span>
                    </button>
                    <Switch
                      aria-labelledby={`${id}-nome`}
                      checked={item.allowedTags.includes(group.tag)}
                      className="shrink-0"
                      disabled={busy}
                      id={id}
                      onCheckedChange={(on) => toggle(group.tag, on)}
                    />
                  </div>
                  {open ? (
                    <div className="border-t bg-background/40">
                      {operations === null ? (
                        <p className="m-0 px-4 py-3 pl-10 text-xs text-muted-foreground">{t("common.loading")}</p>
                      ) : operations === "error" ? (
                        <p className="m-0 px-4 py-3 pl-10 text-xs text-destructive" role="alert">
                          {t("marketplace.api.queriesError")}
                        </p>
                      ) : (
                        <ul aria-label={t("marketplace.api.queriesOf", { group: group.tag })} className="m-0 list-none divide-y p-0">
                          {ops.map((operation) => (
                            <li key={operation.id}>
                              <button
                                className="flex min-h-11 w-full min-w-0 items-center gap-3 py-2 pr-4 pl-10 text-left transition-colors hover:bg-muted/45 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                                onClick={() => setGuide(operation)}
                                type="button"
                              >
                                <span className="w-14 shrink-0 font-mono text-caption font-medium text-muted-foreground">{operation.method}</span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm">{operation.summary || operation.id}</span>
                                  <span className="block truncate font-mono text-xs text-muted-foreground">{operation.path}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="m-0 rounded-xl border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {readable.length === 0 ? t("marketplace.api.noReadGroups") : t("marketplace.api.noGroupFound")}
          </p>
        )}
        <p className="m-0 text-xs text-muted-foreground">{t("marketplace.api.writeSoon")}</p>
      </section>
      {connected ? <ConnectorGuide connectionId={item.id} guide={item.guide} kind="api" /> : null}
      <ToolGuide guide={guide ? apiOperationGuide(guide, translator) : null} onClose={() => setGuide(null)} />
    </div>
  )
}
