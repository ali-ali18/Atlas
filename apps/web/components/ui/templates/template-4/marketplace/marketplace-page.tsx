"use client"
import { Spinner } from "@workspace/ui/components/spinner";

import { useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { ArrowLeftIcon, BracesIcon, CheckIcon, PlugIcon, PlusIcon, SearchIcon } from "lucide-react"
import type { McpCatalogEntry, McpConnectionView } from "@workspace/shared"
import { MCP_MAX_EXPOSED_TOOLS_HINT } from "@workspace/shared"
import { cn } from "@workspace/ui/lib/utils"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  deleteMcpConnection,
  getApiAccountProposal,
  getMcpCatalog,
  listMcpConnections,
  openMcpOAuthPopup,
  reauthMcpConnection,
  startMcpOAuth,
  updateMcpConnection,
  waitMcpOAuthPopup,
  type McpCatalogItem,
  type McpOAuthStartResult,
} from "@/lib/atlas-api"
import { pollMcpOAuthConnection } from "@/lib/mcp-oauth-wait"
import { anotherAccountHint, accountCountText, accountDisplayLabel, groupAccounts, primaryAccount } from "@/lib/connector-accounts"
import { openSettingsModal } from "@/components/settings/settings-url"
import { ApiKeyDialog } from "./api-key-dialog"
import { API_ITEM_PREFIX, ApiConnectionCard, apiItemKey } from "./api-connections-section"
import { ApiConnectionPage } from "./api-connection-page"
import { useApiConnections } from "@/hooks/use-api-connection"
import { ApiAddAccount, ApiManualConnect } from "./api-manual-connect"
import type { ApiProposal } from "@workspace/shared"
import { ComposioApps } from "./composio-apps"
import { connectorAction } from "./connector-action"
import { ConnectorPage } from "./connector-page"
import { GithubAppCallout } from "./github-app-callout"
import { CustomConnectorForm } from "./custom-connector-form"
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon"
import type { CustomMcpDraft } from "@/lib/open-marketplace"
import { MarketplaceSections } from "./marketplace-sections"
import {
  CatalogBotPage,
  CatalogBotsTab,
  CatalogSkillPage,
  CatalogSkillsTab,
  useCatalogData,
} from "./catalog-tabs"
import { CategorySelect } from "./catalog-views"
import { categoriesOf } from "./catalog-state"
import {
  goBackFromMarketplace,
  openMarketplacePage,
  useMarketplaceLocation,
  type MarketplaceSection,
} from "@/lib/marketplace-url"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import { useTranslations } from "@/lib/i18n/provider";

type View =
  | { kind: "catalog" }
  | { kind: "page"; catalogId?: string; connectionId?: string }
  | { kind: "api"; id: string }
  | { kind: "key"; entry: McpCatalogItem }
  | { kind: "custom"; draft?: CustomMcpDraft }
  | { kind: "skill"; slug: string }
  | { kind: "bot"; slug: string }

const sections = [
  { category: "search", titleKey: "marketplace.connector.category.search" },
  { category: "google", titleKey: "marketplace.connector.category.google" },
  { category: "productivity", titleKey: "marketplace.connector.category.productivity" },
  { category: "creative", titleKey: "marketplace.connector.category.creative" },
] as const

const connectorBackgrounds: Record<string, string> = {
  firecrawl: "#FA5D19",
  github: "#181717",
  notion: "#191919",
  slack: "#F2E8F2",
  gmail: "#FCE8E6",
  google_drive: "#E6F4EA",
  google_calendar: "#E8F0FE",
  google_sheets: "#E6F4EA",
  brave_search: "#FB542B",
  higgsfield: "#D1FE17",
}

const googleIconIds = ["gmail", "google_drive", "google_calendar", "google_sheets"]

function ConnectorIcon({
  entry,
  compact = false,
  custom,
}: {
  entry?: Pick<McpCatalogEntry, "id" | "icon">
  compact?: boolean
  /** MCP personalizado: logo do site (via API) ou inicial do nome. */
  custom?: { name: string; url: string }
}) {
  if (!entry && custom) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center border bg-background",
          compact ? "size-6 rounded-md" : "size-12 rounded-2xl"
        )}
      >
        <CustomMcpIcon
          className={compact ? "size-4" : "size-7"}
          name={custom.name}
          url={custom.url}
        />
      </span>
    )
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center border",
        compact ? "size-6 rounded-md" : "size-12 rounded-2xl",
        !entry && "bg-background"
      )}
      style={entry ? { backgroundColor: connectorBackgrounds[entry.id] } : undefined}
    >
      {entry?.icon.startsWith("/connectors/") ? (
        <Image
          alt=""
          className={cn(
            "object-contain",
            compact ? "size-4" : "size-7",
            ["github", "brave_search"].includes(entry.id) &&
              "brightness-0 invert",
            !compact &&
              googleIconIds.includes(entry.id) &&
              "scale-125"
          )}
          height={compact ? 16 : 28}
          src={entry.icon}
          unoptimized
          width={compact ? 16 : 28}
        />
      ) : (
        <PlugIcon className={compact ? "size-4" : "size-6"} />
      )}
    </span>
  )
}

function FeaturedCard({
  entry,
  connection,
  secretBoxReady,
  busy,
  onOpen,
  onAction,
}: {
  entry: McpCatalogItem
  connection?: McpConnectionView
  secretBoxReady: boolean
  busy: boolean
  onOpen: () => void
  onAction: () => void
}) {
  const translator = useTranslations()
  const action = connectorAction({ entry, connection, secretBoxReady, busy, translator })
  return (
    <div className="relative flex min-w-0 flex-col items-center justify-between gap-3 rounded-xl border bg-card/50 px-3 py-5 text-center transition-colors hover:bg-muted/45">
      <button aria-label={translator.t("marketplace.viewDetails", { name: entry.name })} className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={onOpen} type="button" />
      <div className="pointer-events-none flex flex-col items-center gap-3">
        <ConnectorIcon entry={entry} />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{entry.name}</p>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {entry.description}
          </p>
        </div>
      </div>
      <Button
        className="relative z-10 h-7 rounded-full px-3 text-xs"
        disabled={action.disabled}
        onClick={onAction}
        size="sm"
        title={action.title}
        type="button"
        variant="secondary"
      >
        {action.connected ? <CheckIcon className="size-3.5" /> : null}
        {action.label}
      </Button>
    </div>
  )
}

function ConnectorCard({
  entry,
  connection,
  accountLabel,
  secretBoxReady,
  busy = false,
  onOpen,
  onAction,
}: {
  entry?: McpCatalogItem
  connection?: McpConnectionView
  /** Apelido da conta (cartão de conectado): vira o subtítulo no lugar da descrição. */
  accountLabel?: string | null
  secretBoxReady: boolean
  busy?: boolean
  onOpen: () => void
  onAction: () => void
}) {
  const translator = useTranslations()
  const { t } = translator
  const action = connectorAction({ entry, connection, secretBoxReady, busy, translator })
  const displayName = entry?.name ?? connection?.name ?? t("marketplace.connector.customName")
  return (
    <div className="relative flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/45">
      <button aria-label={accountLabel ? t("marketplace.api.viewDetailsAccount", { name: displayName, account: accountLabel }) : t("marketplace.viewDetails", { name: displayName })} className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={onOpen} type="button" />
      <div className="pointer-events-none">
        <ConnectorIcon custom={!entry && connection ? { name: connection.name, url: connection.url } : undefined} entry={entry} />
      </div>
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {displayName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {accountLabel ?? entry?.description ?? connection?.url ?? t("marketplace.page.defaultDescription")}
        </p>
      </div>
      <Button
        className="relative z-10 h-7 shrink-0 rounded-full px-3 text-xs"
        disabled={action.disabled}
        onClick={onAction}
        size="sm"
        title={action.title}
        type="button"
        variant="secondary"
      >
        {action.connected ? <CheckIcon className="size-3.5" /> : null}
        {action.label}
      </Button>
    </div>
  )
}

export function MarketplacePage({
  customDraft,
  onCustomDraftConsumed,
  onManageAutonomy,
  onBotInstalled,
  onOpenBot,
}: {
  /** Pedido do agente: abre "MCP personalizado" preenchido. */
  customDraft?: CustomMcpDraft | null
  onCustomDraftConsumed?: () => void
  /** Abre a tela de Autonomia já filtrada no conector (chave = catálogo ou slug). */
  onManageAutonomy?: (connector: string) => void
  /** Um agente do catálogo foi criado: a lista de agentes precisa recarregar. */
  onBotInstalled?: (botId: string) => void
  /** "Abrir conversa" depois de instalar um agente. */
  onOpenBot?: (botId: string) => void
}) {
	const translator = useTranslations();
  const location = useMarketplaceLocation() ?? { section: "conectores" as const, item: null }
  const { section, item } = location
  const [catalog, setCatalog] = useState<McpCatalogItem[] | null>(null)
  const [connections, setConnections] = useState<McpConnectionView[]>([])
  const [secretBoxReady, setSecretBoxReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Conector com login OAuth em andamento (catalogId ou id da conexão). */
  const [oauthBusy, setOauthBusy] = useState<string | null>(null)
  const oauthAbortRef = useRef<AbortController | null>(null)
  const [query, setQuery] = useState("")
  const [skillCategory, setSkillCategory] = useState("")
  const [botCategory, setBotCategory] = useState("")
  const catalogData = useCatalogData(section === "habilidades" || section === "agentes")
  const [keyEntry, setKeyEntry] = useState<McpCatalogItem | null>(null)
  const [draft, setDraft] = useState<CustomMcpDraft | undefined>(undefined)
  const [apiSheet, setApiSheet] = useState(false)
  const apis = useApiConnections(!apiSheet)
  /** Chave de API de uma conta nova (em vez de reconectar a existente). */
  const [keyNewAccount, setKeyNewAccount] = useState(false)
  /** Conta aberta na página do conector quando há várias. */
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [accountBusyId, setAccountBusyId] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  /** "Adicionar outra conta" de uma API: resumo da API (folha de passos) e o estado do pedido. */
  const [apiAdd, setApiAdd] = useState<ApiProposal | null>(null)
  const [apiAddBusy, setApiAddBusy] = useState(false)
  const [apiAddError, setApiAddError] = useState<string | null>(null)

  /** Conta que representa o conector do catálogo nos cartões: a conectada mais antiga, senão a primeira. */
  const primaryOf = (catalogId: string) =>
    primaryAccount(connections.filter((candidate) => candidate.catalogId === catalogId))

  const searchPlaceholder = translator.t(`marketplace.page.search.${section}`)

  function changeSection(next: MarketplaceSection) {
    setQuery("")
    setKeyEntry(null)
    setKeyNewAccount(false)
    setActionError(null)
    openMarketplacePage({ section: next })
  }

  // Pedido do agente: abre "MCP personalizado" já preenchido.
  useEffect(() => {
    if (!customDraft) return
    setDraft(customDraft)
    openMarketplacePage({ section: "conectores", item: "custom" })
    onCustomDraftConsumed?.()
  }, [customDraft, onCustomDraftConsumed])

  useEffect(() => {
    let cancelled = false
    Promise.all([getMcpCatalog(), listMcpConnections()]).then(
      ([result, loaded]) => {
        if (cancelled) return
        setCatalog(result.entries)
        setSecretBoxReady(result.secretBoxReady)
        setConnections(loaded)
        setError(null)
      },
      (cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : translator.t("marketplace.page.loadError")
          )
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (
      catalog?.filter(
        (entry) =>
          entry.availability !== "coming_soon" &&
          (!term ||
          `${entry.name} ${entry.description}`
            .toLowerCase()
            .includes(term))
      ) ?? []
    )
  }, [catalog, query])
  const connected = connections.filter(
    (connection) =>
      !query.trim() ||
      `${connection.name} ${connection.url}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
  )
  const activeConnections = connections.filter(
    (connection) => connection.status === "connected"
  )
  // "Instalados": MCP ativos + APIs conectadas (mesma pilha de logos do cabeçalho).
  // Um item por serviço (várias contas do mesmo conector contam uma vez).
  const installed = [
    ...groupAccounts(activeConnections, (connection) => connection.catalogId ?? `c.${connection.id}`).map(([connection]) => ({
      id: connection!.id,
      name: connection!.name,
      url: connection!.url,
      catalogId: connection!.catalogId,
    })),
    ...groupAccounts(
      (apis.items ?? []).filter((entry) => entry.status === "connected"),
      (entry) => entry.baseUrl
    ).map(([entry]) => ({ id: `a.${entry!.id}`, name: entry!.name, url: entry!.baseUrl, catalogId: null })),
  ]
  const activeTools = connections.reduce(
    (count, connection) =>
      count +
      (connection.status === "connected"
        ? connection.tools.filter(
            (tool) => !connection.disabledTools.includes(tool.name)
          ).length
        : 0),
    0
  )
  const featured =
    catalog?.filter(
      (entry) =>
        entry.availability !== "coming_soon" &&
        (["firecrawl", "github", "google_drive"].includes(entry.id) ||
          (entry.id === "slack" && entry.oauthReady))
    ) ?? []

  // O detalhe vem do endereço: `item` é o id do catálogo, `c.<id>` (conexão própria) ou `custom`.
  const view: View = keyEntry
    ? { kind: "key", entry: keyEntry }
    : section === "habilidades" && item
      ? { kind: "skill", slug: item }
      : section === "agentes" && item
        ? { kind: "bot", slug: item }
        : section === "conectores" && item === "custom"
          ? { kind: "custom", draft }
          : section === "conectores" && item
            ? item.startsWith(API_ITEM_PREFIX)
              ? { kind: "api", id: item.slice(API_ITEM_PREFIX.length) }
              : item.startsWith("c.")
              ? { kind: "page", connectionId: item.slice(2) }
              : {
                  kind: "page",
                  catalogId: item,
                  connectionId: primaryOf(item)?.id,
                }
            : { kind: "catalog" }

  function setView(next: View) {
    setKeyEntry(null)
    setKeyNewAccount(false)
    if (next.kind === "key") setKeyEntry(next.entry)
    else if (next.kind === "catalog") openMarketplacePage({ section })
    else if (next.kind === "api") openMarketplacePage({ section: "conectores", item: apiItemKey(next.id) })
    else if (next.kind === "custom") {
      setDraft(next.draft)
      openMarketplacePage({ section: "conectores", item: "custom" })
    } else if (next.kind === "page") {
      openMarketplacePage({
        section: "conectores",
        item: next.catalogId ?? (next.connectionId ? `c.${next.connectionId}` : null),
      })
    } else openMarketplacePage({ section: next.kind === "skill" ? "habilidades" : "agentes", item: next.slug })
  }

  const selectedEntry = view.kind === "page"
    ? catalog?.find((entry) => entry.id === view.catalogId)
    : undefined
  const pageAccounts = view.kind === "page" && selectedEntry
    ? connections.filter((entry) => entry.catalogId === selectedEntry.id)
    : []
  const selectedConnection = view.kind === "page"
    ? (pageAccounts.length > 0
        ? (pageAccounts.find((entry) => entry.id === activeAccountId) ??
          pageAccounts.find((entry) => entry.id === view.connectionId) ??
          primaryAccount(pageAccounts))
        : connections.find((entry) => entry.id === view.connectionId))
    : undefined

  function updateConnection(connection: McpConnectionView) {
    setConnections((previous) => {
      const index = previous.findIndex((entry) => entry.id === connection.id)
      if (index < 0) return [...previous, connection]
      return previous.map((entry) =>
        entry.id === connection.id ? connection : entry
      )
    })
  }

  /**
   * Login com um clique: o popup abre já no clique (senão o navegador
   * bloqueia) e o resultado vem do status recarregado da conexão.
   */
  async function runOAuth(
    busyKey: string,
    start: () => Promise<McpOAuthStartResult>
  ) {
    if (oauthBusy) return
    const popup = openMcpOAuthPopup()
    setOauthBusy(busyKey)
    setActionError(null)
    try {
      const started = await start()
      updateConnection(started.connection)
      let latest: McpConnectionView | undefined
      const load = async () => {
        const loaded = await listMcpConnections()
        setConnections(loaded)
        latest = loaded.find((entry) => entry.id === started.connection.id)
        return latest
      }
      if (started.authorizeUrl) {
        const controller = new AbortController()
        oauthAbortRef.current = controller
        const result = await pollMcpOAuthConnection({
          popup: waitMcpOAuthPopup(popup, started.authorizeUrl),
          load,
          signal: controller.signal,
        })
        oauthAbortRef.current = null
        popup?.close()
        if (result.cancelled) return
        if (!result.ok) {
          setActionError(result.error ?? translator.t("marketplace.page.loginIncomplete"))
          return
        }
      } else {
        popup?.close()
        await load()
      }
      const fresh = latest as McpConnectionView | undefined
      if (fresh?.status === "connected") {
        setActiveAccountId(fresh.id)
        setView({ kind: "page", catalogId: fresh.catalogId ?? undefined, connectionId: fresh.id })
      } else {
        setActionError(fresh?.lastError ?? translator.t("marketplace.page.loginIncomplete"))
      }
    } catch (cause) {
      popup?.close()
      setActionError(cause instanceof Error ? cause.message : translator.t("marketplace.page.loginStartError"))
    } finally {
      setOauthBusy(null)
    }
  }

  function openEntry(entry: McpCatalogItem) {
    const connection = primaryOf(entry.id)
    if (connection?.status === "connected") {
      setView({ kind: "page", catalogId: entry.id, connectionId: connection.id })
    } else if (entry.authType === "oauth" && entry.oauthReady) {
      void runOAuth(entry.id, () => startMcpOAuth({ catalogId: entry.id }))
    } else if (entry.apiKey) {
      // api_key, ou GitHub sem app OAuth configurado → token pessoal.
      setView({ kind: "key", entry })
    } else if (connection) {
      setView({ kind: "page", catalogId: entry.id, connectionId: connection.id })
    }
  }

  /** Outra conta do mesmo conector: nova conexão (nunca reaproveita a existente). */
  function addAccount(entry: McpCatalogItem) {
    setAccountError(null)
    if (entry.authType === "oauth" && entry.oauthReady) {
      void runOAuth(`add:${entry.id}`, () => startMcpOAuth({ catalogId: entry.id, newAccount: true }))
    } else if (entry.apiKey) {
      setKeyNewAccount(true)
      setKeyEntry(entry)
    }
  }

  async function runAccount(id: string, action: () => Promise<void>) {
    setAccountBusyId(id)
    setAccountError(null)
    try {
      await action()
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : translator.t("marketplace.page.finishError"))
    } finally {
      setAccountBusyId(null)
    }
  }

  const renameAccount = (id: string, label: string) =>
    runAccount(id, async () => updateConnection(await updateMcpConnection(id, { accountLabel: label || null })))

  const disconnectAccount = (id: string) =>
    runAccount(id, async () => {
      await deleteMcpConnection(id)
      const remaining = connections.filter((entry) => entry.id !== id)
      setConnections(remaining)
      setActiveAccountId(null)
      if (!remaining.some((entry) => entry.catalogId === selectedEntry?.id)) goBackFromMarketplace()
    })

  async function addApiAccount(id: string) {
    setApiAddBusy(true)
    setApiAddError(null)
    try {
      setApiAdd(await getApiAccountProposal(id))
    } catch (cause) {
      setApiAddError(cause instanceof Error ? cause.message : translator.t("marketplace.page.startError"))
    } finally {
      setApiAddBusy(false)
    }
  }

  function openConnection(connection: McpConnectionView) {
    const entry = catalog?.find((candidate) => candidate.id === connection.catalogId)
    if (connection.status !== "connected" && connection.authType === "oauth") {
      // Reconecta ESTA conta (com várias contas, não a "primeira" do catálogo).
      void runOAuth(connection.id, () => reauthMcpConnection(connection.id))
    } else if (entry && connection.status !== "connected") {
      openEntry(entry)
    } else {
      setView({ kind: "page", catalogId: entry?.id, connectionId: connection.id })
    }
  }

  const selectedApi = view.kind === "api" ? apis.items?.find((entry) => entry.id === view.id) : undefined
  const apiTerm = query.trim().toLowerCase()
  const apiGroups = groupAccounts(
    (apis.items ?? []).filter(
      (entry) => !apiTerm || `${entry.name} ${entry.domain}`.toLowerCase().includes(apiTerm)
    ),
    (entry) => entry.baseUrl
  )
  const connectedGroups = groupAccounts(connected, (connection) => connection.catalogId ?? `c.${connection.id}`)
  const detail = view.kind !== "catalog"
  const title =
    view.kind === "key"
      ? translator.t("marketplace.page.connectTitle", { name: view.entry.name })
      : view.kind === "api"
        ? (selectedApi?.name ?? translator.t("marketplace.page.apiFallback"))
      : view.kind === "custom"
        ? translator.t("marketplace.connector.customName")
        : view.kind === "skill"
          ? translator.t("marketplace.page.skillTitle")
          : view.kind === "bot"
            ? translator.t("marketplace.page.agentTitle")
            : view.kind === "page"
              ? (selectedEntry?.name ?? selectedConnection?.name ?? translator.t("marketplace.page.connectorFallback"))
              : translator.t("marketplace.page.title")
  const showCategory = !detail && (section === "habilidades" || section === "agentes")
  const categoryItems = section === "habilidades" ? (catalogData.data?.skills ?? []) : (catalogData.data?.bots ?? [])
  const goBack = () => {
    if (keyEntry) {
      setKeyEntry(null)
      setKeyNewAccount(false)
    } else goBackFromMarketplace()
  }
  const connectorGrid = "grid gap-x-5 gap-y-1 md:grid-cols-2 xl:grid-cols-3"

  return (
    <main
      aria-label={translator.t("marketplace.page.title")}
      className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-slot="marketplace-page"
    >
      <header className="z-20 shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 md:px-8 md:pt-6">
          <div className="flex min-h-9 items-center gap-2">
            <Button aria-label={translator.t("common.back")} className="-ml-2 shrink-0" onClick={goBack} size="icon" type="button" variant="ghost">
              <ArrowLeftIcon aria-hidden />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">{title}</h1>
            {installed.length > 0 && !detail ? (
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex -space-x-1.5">
                  {installed.slice(0, 4).map((connection) => (
                    <span
                      className="rounded-md ring-2 ring-background"
                      key={connection.id}
                      title={connection.name}
                    >
                      <ConnectorIcon
                        compact
                        custom={{ name: connection.name, url: connection.url }}
                        entry={catalog?.find(
                          (entry) => entry.id === connection.catalogId
                        )}
                      />
                    </span>
                  ))}
                  {installed.length > 4 && (
                    <span className="grid size-6 place-items-center rounded-md border bg-muted text-[10px] ring-2 ring-background">
                      +{installed.length - 4}
                    </span>
                  )}
                </div>
                <p className="hidden text-sm text-muted-foreground md:block">
                  {translator.t("marketplace.page.installed", { count: installed.length })}
                </p>
              </div>
            ) : null}
          </div>
          {!detail ? (
            <>
              <MarketplaceSections onChange={changeSection} section={section} />
              <div className={cn("flex min-w-0 gap-2", section === "conectores" ? "items-center" : "flex-col sm:flex-row sm:items-center")}>
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupAddon><SearchIcon /></InputGroupAddon>
                  <InputGroupInput
                    aria-label={searchPlaceholder}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    value={query}
                  />
                </InputGroup>
                {section === "conectores" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button className="h-auto shrink-0 self-stretch" type="button" variant="secondary" />}>
                      <PlusIcon aria-hidden /> {translator.t("marketplace.page.customMenu")}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52">
                      <DropdownMenuItem onClick={() => setView({ kind: "custom" })}>
                        <PlugIcon /> {translator.t("marketplace.connector.customName")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setApiSheet(true)}>
                        <BracesIcon /> {translator.t("marketplace.page.connectApi")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {showCategory ? (
                  <CategorySelect
                    categories={categoriesOf(categoryItems, translator)}
                    category={section === "habilidades" ? skillCategory : botCategory}
                    onCategory={section === "habilidades" ? setSkillCategory : setBotCategory}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[1100px] space-y-5 px-4 py-5 md:px-8 md:py-6">
          {oauthBusy ? (
            <Alert>
              <Spinner />
              <AlertTitle>{translator.t("marketplace.page.waitingLogin")}</AlertTitle>
              <AlertDescription>
                {translator.t("marketplace.page.waitingLoginText")}
              </AlertDescription>
              {oauthBusy.startsWith("add:") ? (
                <AlertDescription className="mt-1">{anotherAccountHint()}</AlertDescription>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => oauthAbortRef.current?.abort()}
              >
                {translator.t("common.cancel")}
              </Button>
            </Alert>
          ) : null}
          {actionError ? (
            <Alert variant="destructive">
              <AlertTitle>{translator.t("marketplace.page.cantConnect")}</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          {view.kind === "key" ? (
            <div className="mx-auto max-w-[860px] space-y-5">
              {view.entry.id === "github" ? (
                <GithubAppCallout onOpenSettings={() => openSettingsModal()} />
              ) : null}
              <ApiKeyDialog
                entry={view.entry}
                newAccount={keyNewAccount}
                onBack={() => {
                  setKeyEntry(null)
                  setKeyNewAccount(false)
                }}
                onConnected={(connection) => {
                  updateConnection(connection)
                  setActiveAccountId(connection.id)
                  setView({ kind: "page", catalogId: view.entry.id, connectionId: connection.id })
                }}
              />
            </div>
          ) : view.kind === "api" ? (
            <div className="mx-auto max-w-[860px]">
              {selectedApi ? (
                <ApiConnectionPage
                  accounts={{
                    items: (apis.items ?? []).filter((entry) => entry.baseUrl === selectedApi.baseUrl),
                    adding: apiAddBusy,
                    error: apiAddError,
                    onAdd: () => void addApiAccount(selectedApi.id),
                    onOpen: (id) => setView({ kind: "api", id }),
                    onRename: (id, label) => void apis.rename(id, label),
                    onRemove: (id) =>
                      void apis.remove(id).then((ok) => {
                        if (!ok) return
                        const left = (apis.items ?? []).filter((entry) => entry.baseUrl === selectedApi.baseUrl && entry.id !== id)
                        if (id === selectedApi.id && left[0]) setView({ kind: "api", id: left[0].id })
                        else if (left.length === 0) goBackFromMarketplace()
                      }),
                  }}
                  busy={apis.busyId === selectedApi.id}
                  busyId={apis.busyId}
                  error={apis.error}
                  item={selectedApi}
                  onReconnect={(input) => void apis.reconnect(selectedApi, input)}
                  onRemove={() => void apis.remove(selectedApi.id).then((ok) => ok && goBackFromMarketplace())}
                  onSaveGroups={(tags) => void apis.saveGroups(selectedApi.id, tags)}
                />
              ) : apis.items ? (
                <p className="m-0 text-sm text-muted-foreground">{translator.t("marketplace.page.apiNotFound")}</p>
              ) : (
                <Skeleton className="h-40 rounded-2xl" />
              )}
            </div>
          ) : view.kind === "custom" ? (
            <div className="mx-auto max-w-[860px]">
              <CustomConnectorForm
                initial={view.draft}
                busy={oauthBusy === "custom"}
                onBack={goBack}
                onOAuth={(custom) =>
                  runOAuth("custom", () => startMcpOAuth({ custom: { ...custom, oauth: true } }))
                }
                onConnected={(connection) => {
                  updateConnection(connection)
                  setView({ kind: "page", connectionId: connection.id })
                }}
              />
            </div>
          ) : view.kind === "skill" ? (
            <div className="mx-auto max-w-[860px]">
              <CatalogSkillPage onChanged={catalogData.reload} slug={view.slug} />
            </div>
          ) : view.kind === "bot" ? (
            <div className="mx-auto max-w-[860px]">
              <CatalogBotPage
                onBotInstalled={onBotInstalled}
                onChanged={catalogData.reload}
                onOpenBot={onOpenBot}
                slug={view.slug}
              />
            </div>
          ) : view.kind === "page" ? (
            <div className="mx-auto max-w-[860px] space-y-5">
              {selectedEntry?.id === "github" ? (
                <GithubAppCallout onOpenSettings={() => openSettingsModal()} />
              ) : null}
              <ConnectorPage
                accountBusyId={accountBusyId}
                accountError={accountError}
                accounts={pageAccounts}
                adding={!!selectedEntry && oauthBusy === `add:${selectedEntry.id}`}
                connection={selectedConnection}
                entry={selectedEntry}
                onAddAccount={selectedEntry ? () => addAccount(selectedEntry) : undefined}
                onDisconnectAccount={disconnectAccount}
                onReconnectAccount={(id) => {
                  const account = connections.find((entry) => entry.id === id)
                  if (account) openConnection(account)
                }}
                onRenameAccount={renameAccount}
                onSelectAccount={setActiveAccountId}
                icon={<ConnectorIcon custom={selectedConnection ? { name: selectedConnection.name, url: selectedConnection.url } : undefined} entry={selectedEntry} />}
                secretBoxReady={secretBoxReady}
                busy={
                  !!oauthBusy &&
                  (oauthBusy === selectedEntry?.id || oauthBusy === selectedConnection?.id)
                }
                onAction={() =>
                  selectedEntry
                    ? openEntry(selectedEntry)
                    : selectedConnection && openConnection(selectedConnection)
                }
                onManageAutonomy={onManageAutonomy}
                onChanged={updateConnection}
                onDeleted={(id) => {
                  setConnections((previous) =>
                    previous.filter((entry) => entry.id !== id)
                  )
                  goBackFromMarketplace()
                }}
              />
            </div>
          ) : section === "habilidades" ? (
            <div aria-labelledby="marketplace-section-habilidades" id="marketplace-panel-habilidades" role="tabpanel">
              <CatalogSkillsTab
                category={skillCategory}
                data={catalogData.data}
                error={catalogData.error}
                loading={catalogData.loading}
                onCategory={setSkillCategory}
                onOpen={(slug) => setView({ kind: "skill", slug })}
                onReload={catalogData.reload}
                query={query}
              />
            </div>
          ) : section === "agentes" ? (
            <div aria-labelledby="marketplace-section-agentes" id="marketplace-panel-agentes" role="tabpanel">
              <CatalogBotsTab
                category={botCategory}
                data={catalogData.data}
                error={catalogData.error}
                loading={catalogData.loading}
                onBotInstalled={onBotInstalled}
                onCategory={setBotCategory}
                onOpen={(slug) => setView({ kind: "bot", slug })}
                onOpenBot={onOpenBot}
                onReload={catalogData.reload}
                query={query}
              />
            </div>
          ) : (
            <div
              aria-labelledby={`marketplace-section-${section}`}
              className="space-y-6"
              id={`marketplace-panel-${section}`}
              role="tabpanel"
            >
              {section === "apps" ? (
                <div>
                  <ComposioApps
                    nativeConnections={connections}
                    onManageKey={() => openSettingsModal("composio")}
                    open
                    query={query}
                  />
                </div>
              ) : (
                <div className="space-y-6">
                  {error ? (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}
                  {!secretBoxReady && catalog ? (
                    <Alert variant="warning">
                      <AlertTitle>{translator.t("marketplace.page.vaultTitle")}</AlertTitle>
                      <AlertDescription>
                        {translator.t("marketplace.page.vaultText")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {activeTools > MCP_MAX_EXPOSED_TOOLS_HINT ? (
                    <p className="text-xs text-muted-foreground">
                      {translator.t("marketplace.page.toolsLimit", { max: MCP_MAX_EXPOSED_TOOLS_HINT })}
                    </p>
                  ) : null}
                  {!catalog && !error ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton className="h-18 rounded-2xl" key={index} />
                      ))}
                    </div>
                  ) : null}
                  {!query.trim() && featured.length > 0 ? (
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold">{translator.t("marketplace.page.featured")}</h3>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                        {featured.map((entry) => (
                          <FeaturedCard
                            connection={primaryOf(entry.id)}
                            entry={entry}
                            key={entry.id}
                            onOpen={() => setView({ kind: "page", catalogId: entry.id, connectionId: primaryOf(entry.id)?.id })}
                            onAction={() => openEntry(entry)}
                            busy={oauthBusy === entry.id}
                            secretBoxReady={secretBoxReady}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {apis.error && !apis.items ? (
                    <p className="m-0 text-xs text-destructive" role="alert">
                      {apis.error}
                    </p>
                  ) : null}
                  {connected.length > 0 || apiGroups.length > 0 ? (
                    <section className="space-y-2">
                      <h3 className="text-sm font-medium">{translator.t("marketplace.page.connected")}</h3>
                      <div className={connectorGrid}>
                        {connectedGroups.map((group) => {
                          const connection = primaryAccount(group)!
                          return (
                          <ConnectorCard
                            accountLabel={
                              group.length > 1
                                ? accountCountText(group.length)
                                : accountDisplayLabel(
                                    connection,
                                    connection.catalogId
                                      ? connections.filter((candidate) => candidate.catalogId === connection.catalogId)
                                      : [connection]
                                  )
                            }
                            connection={connection}
                            entry={catalog?.find(
                              (entry) => entry.id === connection.catalogId
                            )}
                            key={connection.id}
                            onOpen={() => {
                              setActiveAccountId(connection.id)
                              setView({ kind: "page", catalogId: connection.catalogId ?? undefined, connectionId: connection.id })
                            }}
                            onAction={() => openConnection(connection)}
                            busy={oauthBusy === connection.id || (!!connection.catalogId && oauthBusy === connection.catalogId)}
                            secretBoxReady={secretBoxReady}
                          />
                          )
                        })}
                        {apiGroups.map((group) => {
                          const entry = primaryAccount(group)!
                          return (
                          <ApiConnectionCard
                            accountCount={group.length}
                            accountLabel={accountDisplayLabel(entry, (apis.items ?? []).filter((candidate) => candidate.baseUrl === entry.baseUrl))}
                            item={entry}
                            key={entry.baseUrl}
                            onOpen={() => setView({ kind: "api", id: entry.id })}
                          />
                          )
                        })}
                      </div>
                    </section>
                  ) : null}
                  {sections.map(({ category, titleKey }) => {
                    const entries = filtered.filter(
                      (entry) => entry.category === category
                    )
                    if (entries.length === 0) return null
                    return (
                      <section className="space-y-2" key={category}>
                        <h3 className="text-sm font-medium">{translator.t(titleKey)}</h3>
                        <div className={connectorGrid}>
                          {entries.map((entry) => (
                            <ConnectorCard
                              connection={primaryOf(entry.id)}
                              entry={entry}
                              key={entry.id}
                              onOpen={() => setView({ kind: "page", catalogId: entry.id, connectionId: primaryOf(entry.id)?.id })}
                              onAction={() => openEntry(entry)}
                              busy={oauthBusy === entry.id}
                              secretBoxReady={secretBoxReady}
                            />
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ApiManualConnect onOpenChange={setApiSheet} open={apiSheet} />
      <ApiAddAccount
        onClose={() => setApiAdd(null)}
        onConnected={() => void apis.reload()}
        proposal={apiAdd}
      />
    </main>
  )
}
