"use client"

import { ConnectorGuide } from "./connector-guide"
import { useEffect, useMemo, useState } from "react"
import { ChevronRightIcon, SearchIcon } from "lucide-react"
import { API_AUTH_LABEL, type ApiConnectionView, type ApiOperation } from "@workspace/shared"
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

const consultas = (count: number) => `${count} ${count === 1 ? "consulta" : "consultas"}`

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
    const term = query.trim().toLocaleLowerCase("pt-BR")
    return term ? readable.filter((group) => group.tag.toLocaleLowerCase("pt-BR").includes(term)) : readable
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
              {busy ? "Conectando…" : "Reconectar"}
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
              {confirming ? "Confirmar" : "Desconectar"}
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
            aria-label={item.authKind === "bearer" ? "Novo token de acesso" : "Nova chave de API"}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={item.authKind === "bearer" ? "Novo token" : "Nova chave"}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
          <Button disabled={busy || !apiKey.trim()} type="submit">
            Salvar
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
              status: apiConnectionStatusLabel(account),
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
        <h3 className="text-sm font-semibold">Resumo</h3>
        <dl className="m-0 divide-y rounded-xl border bg-muted/20 px-4">
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="shrink-0 text-muted-foreground">Endereço</dt>
            <dd className="m-0 min-w-0 break-all text-right font-mono text-xs leading-5">{item.baseUrl}</dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="text-muted-foreground">Autenticação</dt>
            <dd className="m-0">{API_AUTH_LABEL[item.authKind]}</dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="shrink-0 text-muted-foreground">Estado</dt>
            <dd
              className={cn(
                "m-0 min-w-0 text-right",
                connected ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"
              )}
            >
              {apiConnectionStatusLabel(item)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-3 text-sm">
            <dt className="text-muted-foreground">Acesso</dt>
            <dd className="m-0">{apiAccessSummary(item)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold">
            Grupos{" "}
            <span className="font-normal text-muted-foreground">
              {item.allowedTags.length} de {readable.length}
            </span>
          </h3>
          {accounts && siblings.length > 1 ? (
            <AccountTabs
              accounts={siblings.map((account) => ({ id: account.id, title: accountDisplayLabel(account, siblings) ?? account.name }))}
              label="Conta em configuração"
              onChange={accounts.onOpen}
              value={item.id}
            />
          ) : null}
          <div aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground">
            {busy ? <span className="mr-1">Salvando…</span> : null}
            <Button
              className="h-7 rounded-full px-3 text-xs"
              disabled={busy || item.allowedTags.length === readable.length}
              onClick={() => onSaveGroups(readable.map((group) => group.tag))}
              size="sm"
              type="button"
              variant="ghost"
            >
              Liberar todos
            </Button>
            <Button
              className="-mr-3 h-7 rounded-full px-3 text-xs"
              disabled={busy || item.allowedTags.length === 0}
              onClick={() => onSaveGroups([])}
              size="sm"
              type="button"
              variant="ghost"
            >
              Nenhum
            </Button>
          </div>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Buscar grupo"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar grupo"
            value={query}
          />
        </InputGroup>
        {visible.length > 0 ? (
          <ul aria-label="Grupos liberados" className="m-0 list-none divide-y rounded-xl border bg-muted/20 p-0">
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
                        <span className="block text-xs text-muted-foreground">{consultas(group.read)}</span>
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
                        <p className="m-0 px-4 py-3 pl-10 text-xs text-muted-foreground">Carregando…</p>
                      ) : operations === "error" ? (
                        <p className="m-0 px-4 py-3 pl-10 text-xs text-destructive" role="alert">
                          Não foi possível carregar as consultas.
                        </p>
                      ) : (
                        <ul aria-label={`Consultas de ${group.tag}`} className="m-0 list-none divide-y p-0">
                          {ops.map((operation) => (
                            <li key={operation.id}>
                              <button
                                className="flex min-h-11 w-full min-w-0 items-center gap-3 py-2 pr-4 pl-10 text-left transition-colors hover:bg-muted/45 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                                onClick={() => setGuide(operation)}
                                type="button"
                              >
                                <span className="w-14 shrink-0 font-mono text-[11px] font-medium text-muted-foreground">{operation.method}</span>
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
            {readable.length === 0 ? "Esta API não tem grupos de leitura." : "Nenhum grupo encontrado."}
          </p>
        )}
        <p className="m-0 text-xs text-muted-foreground">Ações de escrita chegam em breve.</p>
      </section>
      {connected ? <ConnectorGuide connectionId={item.id} guide={item.guide} kind="api" /> : null}
      <ToolGuide guide={guide ? apiOperationGuide(guide) : null} onClose={() => setGuide(null)} />
    </div>
  )
}
