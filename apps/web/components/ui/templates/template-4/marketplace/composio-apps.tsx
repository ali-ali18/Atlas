"use client"

import { useEffect } from "react"
import { ExternalLinkIcon } from "lucide-react"
import type {
  ComposioCategoryView,
  ComposioConnectedAppView,
  ComposioStatusView,
  ComposioToolkitView,
  McpConnectionView,
} from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import { ComposioAppIcon } from "@/components/ai-elements/connectors/composio-app-icon"
import { ComposioKeyForm } from "@/components/settings/composio-key-form"
import { ComposioPagerBar } from "@/components/settings/composio-pager"
import { useComposio } from "@/hooks/use-composio"
import { COMPOSIO_SITE_URL, type ComposioPager } from "@/components/settings/composio-state"
import { useTranslations } from "@/lib/i18n/provider"

/** Texto em pt-BR (idioma-fonte); a tela mostra `marketplace.composio.nativeWins`. */
export const NATIVE_WINS_BADGE = "Já conectado nativamente"
const ALL_CATEGORIES = "all"

export type ComposioAppsViewProps = {
  /** `null` = ainda carregando o estado da chave. */
  status: ComposioStatusView | null
  loading: boolean
  toolkits: readonly ComposioToolkitView[]
  /** Contas já conectadas (para achar o id a desconectar). */
  connections: readonly Pick<ComposioConnectedAppView, "id" | "toolkit">[]
  error: string | null
  busy: string | null
  nativeConnections: readonly Pick<McpConnectionView, "catalogId" | "status">[]
  categories: readonly ComposioCategoryView[]
  category: string
  pager: ComposioPager
  hasNext: boolean
  totalItems: number | null
  onCategory: (category: string) => void
  onPrev: () => void
  onNext: () => void
  onSaveKey: (apiKey: string) => void
  onConnect: (slug: string, noAuth?: boolean) => void
  onDisconnect: (accountId: string) => void
  onManageKey: () => void
}

/** Sem chave: explicação curta, link para criar a chave e o campo para colar. */
function ComposioKeyPanel({
  status,
  busy,
  error,
  onSaveKey,
}: Pick<ComposioAppsViewProps, "busy" | "error" | "onSaveKey"> & {
  status: ComposioStatusView
}) {
  const { t } = useTranslations()
  return (
    <div className="space-y-3 rounded-2xl border p-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("marketplace.composio.keyTitle")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("marketplace.composio.keyText")}{" "}
          <a
            className="inline-flex items-center gap-1 underline underline-offset-2"
            href={COMPOSIO_SITE_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("marketplace.composio.createKey")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </p>
      </div>
      <ComposioKeyForm
        busy={busy === "key"}
        className="max-w-md"
        disabled={!status.secretBoxReady}
        inputId="marketplace-composio-key"
        onSave={onSaveKey}
      />
      {!status.secretBoxReady ? (
        <p className="text-xs text-destructive" role="alert">
          {t("marketplace.composio.needsEncryptionKey")}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function CategoryFilter({
  categories,
  category,
  onCategory,
}: Pick<ComposioAppsViewProps, "categories" | "category" | "onCategory">) {
  const { t } = useTranslations()
  if (categories.length === 0) return null
  return (
    <Select
      onValueChange={(next) =>
        onCategory(next === ALL_CATEGORIES ? "" : String(next))
      }
      value={category || ALL_CATEGORIES}
    >
      <SelectTrigger
        aria-label={t("marketplace.filterCategory")}
        className="h-8 w-fit min-w-40 text-xs"
        size="sm"
      >
        <SelectValue>
          {(current) =>
            current === ALL_CATEGORIES
              ? t("marketplace.allCategories")
              : (categories.find((item) => item.id === current)?.name ??
                current)
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_CATEGORIES}>{t("marketplace.allCategories")}</SelectItem>
        {categories.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ComposioAppRow({
  app,
  native,
  accountId,
  busy,
  onConnect,
  onDisconnect,
}: {
  app: ComposioToolkitView
  native: boolean
  accountId: string | null
  busy: string | null
  onConnect: ComposioAppsViewProps["onConnect"]
  onDisconnect: ComposioAppsViewProps["onDisconnect"]
}) {
  const { t } = useTranslations()
  const connectLabel = app.noAuth ? t("marketplace.composio.enable") : t("marketplace.composio.connect")
  const disconnectLabel = app.noAuth ? t("marketplace.composio.disable") : t("marketplace.composio.disconnect")
  const connected = app.connected || accountId !== null
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5">
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl border bg-background">
        <ComposioAppIcon className="size-7" logo={app.logo} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{app.name}</span>
          {app.noAuth ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption font-normal text-muted-foreground">
              {t("marketplace.composio.noAuth")}
            </span>
          ) : null}
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {connected
            ? app.noAuth
              ? t("marketplace.composio.enabledBy")
              : t("marketplace.composio.connectedBy")
            : (app.description ?? "")}
        </p>
      </div>
      {connected ? (
        <Button
          aria-label={`${disconnectLabel} ${app.name}`}
          disabled={busy !== null || !accountId}
          onClick={() => accountId && onDisconnect(accountId)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === accountId ? t("marketplace.composio.wait") : disconnectLabel}
        </Button>
      ) : native ? (
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-caption text-muted-foreground">
          {t("marketplace.composio.nativeWins")}
        </span>
      ) : (
        <Button
          aria-label={`${connectLabel} ${app.name}`}
          disabled={busy !== null}
          onClick={() => onConnect(app.slug, app.noAuth)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {busy === app.slug ? t("marketplace.composio.wait") : connectLabel}
        </Button>
      )}
    </div>
  )
}

/** Aba Composio: chave inline, catálogo paginado, categoria e conectar. */
export function ComposioAppsView(props: ComposioAppsViewProps) {
  const {
    status,
    loading,
    toolkits,
    connections,
    error,
    busy,
    nativeConnections,
    hasNext,
    pager,
    totalItems,
  } = props
  const { t } = useTranslations()
  const configured = status?.configured === true
  return (
    <section aria-label={t("marketplace.composio.appsLabel")} className="space-y-3">
      {!status && !error ? (
        <div aria-label={t("marketplace.composio.loadingApps")}>
          <Skeleton className="h-18 rounded-xl" />
        </div>
      ) : null}
      {!status && error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status && !configured ? (
        <ComposioKeyPanel
          busy={busy}
          error={error}
          onSaveKey={props.onSaveKey}
          status={status}
        />
      ) : null}
      {status && configured ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <CategoryFilter
                categories={props.categories}
                category={props.category}
                onCategory={props.onCategory}
              />
              {totalItems ? (
                <span className="text-xs text-muted-foreground">
                  {t("marketplace.composio.appsCount", { count: totalItems })}
                </span>
              ) : null}
            </div>
            <button
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={props.onManageKey}
              type="button"
            >
              {t("marketplace.composio.manageKey", { hint: status.keyHint ?? "••••" })}
            </button>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {loading && toolkits.length === 0 ? (
            <div
              aria-label={t("marketplace.composio.loadingApps")}
              className="grid gap-3 sm:grid-cols-2"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton className="h-16 rounded-xl" key={index} />
              ))}
            </div>
          ) : (
            <div
              aria-busy={loading}
              className={cn(
                "grid gap-x-5 gap-y-1 transition-opacity sm:grid-cols-2",
                loading && "opacity-60"
              )}
            >
              {toolkits.map((app) => {
                const native =
                  !!app.nativeCatalogId &&
                  nativeConnections.some(
                    (item) =>
                      item.catalogId === app.nativeCatalogId &&
                      item.status === "connected"
                  )
                return (
                  <ComposioAppRow
                    accountId={
                      connections.find((item) => item.toolkit === app.slug)
                        ?.id ?? null
                    }
                    app={app}
                    busy={busy}
                    key={app.slug}
                    native={native}
                    onConnect={props.onConnect}
                    onDisconnect={props.onDisconnect}
                  />
                )
              })}
            </div>
          )}
          {!loading && !error && toolkits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("marketplace.composio.empty")}
            </p>
          ) : null}
          <ComposioPagerBar
            disabled={loading}
            hasNext={hasNext}
            onNext={props.onNext}
            onPrev={props.onPrev}
            pager={pager}
            totalItems={totalItems}
          />
        </>
      ) : null}
    </section>
  )
}

export function ComposioApps({
  open,
  query,
  nativeConnections,
  onManageKey,
}: {
  open: boolean
  query: string
  nativeConnections: ComposioAppsViewProps["nativeConnections"]
  onManageKey: () => void
}) {
  const state = useComposio(open)
  const { setSearch } = state
  // A busca do Marketplace filtra o catálogo (e volta para a página 1).
  useEffect(() => {
    setSearch(query)
  }, [query, setSearch])
  return (
    <ComposioAppsView
      busy={state.busy}
      categories={state.categories}
      category={state.category}
      connections={state.connections}
      error={state.error ?? state.listError}
      hasNext={state.nextCursor !== null}
      loading={state.loading}
      nativeConnections={nativeConnections}
      onCategory={state.setCategory}
      onConnect={(slug, noAuth) => void state.connect(slug, { noAuth })}
      onDisconnect={(id) => void state.disconnect(id)}
      onManageKey={onManageKey}
      onNext={state.nextPage}
      onPrev={state.prevPage}
      onSaveKey={(key) => void state.saveKey(key)}
      pager={state.pager}
      status={state.status}
      toolkits={state.toolkits}
      totalItems={state.totalItems}
    />
  )
}
