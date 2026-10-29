"use client"
import { useEffect, useRef, useState } from "react"
import type { LoginConnector } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card"
import { useComposio } from "@/hooks/use-composio"
import {
  nativeConnectorAction,
  useNativeConnector,
} from "@/hooks/use-native-connector"
import { requestMarketplace } from "@/lib/open-marketplace"
import { useTranslations } from "@/lib/i18n/provider"
import type { TFunction } from "@/lib/i18n/translator"
import { openSettingsModal } from "@/components/settings/settings-url"
import { ConnectorIcon } from "@/components/ai-elements/connectors/connector-icon"
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon"
import { requestCustomMcp } from "@/lib/open-marketplace"
import { useCustomMcpConnection } from "@/hooks/use-custom-mcp-connection"
import { ApiConnectCard } from "@/components/ai-elements/login/api-connect-card"

/** `connect` = login de um clique; `configure` = falta a chave do Composio; `marketplace` = sem login de um clique; `loading` = carregando o catálogo. */
export type ConnectorCardAction =
  | "connect"
  | "configure"
  | "marketplace"
  | "loading"

function descriptionOf(connector: LoginConnector, action: ConnectorCardAction, t: TFunction) {
  if (connector.kind === "custom" && action === "connect" && !connector.description)
    return t("aiElements.connector.customDescription")
  if (action === "configure") return t("aiElements.connector.configureDescription")
  return (
    connector.description ||
    (connector.noAuth ? t("aiElements.connector.noAuthDescription") : null) ||
    t("aiElements.connector.defaultDescription")
  )
}

/**
 * Card de conexão de app: ícone, nome e descrição do conector, com o botão que
 * dispara o fluxo normal (OAuth do Marketplace ou popup do Composio). Nunca
 * recebe credencial; o run só retoma depois da conexão confirmada.
 */
export function ConnectorLoginCardView({
  connector,
  status = "pending",
  action,
  connected,
  busy,
  error,
  onAction,
  onDone,
  onDismiss,
  dismissed = false,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  action: ConnectorCardAction
  connected: boolean
  busy: boolean
  error?: string | null
  onAction: () => void
  onDone?: () => void
  /** Só no MCP personalizado: "Agora não" recolhe o card sem conectar. */
  onDismiss?: () => void
  dismissed?: boolean
}) {
  const { t } = useTranslations()
  const done = status === "done"
  const verb = connector.noAuth
    ? t("aiElements.connector.enable")
    : connector.reconnect
      ? t("aiElements.connector.reconnect")
      : t("aiElements.connector.connect")
  const label =
    action === "configure"
      ? t("aiElements.connector.setUpComposio")
      : action === "marketplace"
        ? t("aiElements.connector.enterKey")
        : verb
  return (
    <RequestCard
      actions={
        <>
          {!connected && (
            <Button
              className={REQUEST_PRIMARY_CLASS}
              disabled={busy || action === "loading"}
              onClick={onAction}
              size="sm"
              type="button"
            >
              {busy ? (connector.noAuth ? t("aiElements.connector.enabling") : t("aiElements.connector.connecting")) : label}
            </Button>
          )}
          {!connected && onDismiss && (
            <Button disabled={busy} onClick={onDismiss} size="sm" type="button" variant="ghost">
              {t("aiElements.connector.notNow")}
            </Button>
          )}
          {(connected || !onDismiss) && (
          <Button
            disabled={!connected || busy}
            onClick={onDone}
            className={connected ? REQUEST_PRIMARY_CLASS : undefined}
            size="sm"
            type="button"
            variant={connected ? "default" : "secondary"}
          >
            {t("aiElements.connector.resume")}
          </Button>
          )}
        </>
      }
      aria-label={t("aiElements.connector.verbName", { verb, name: connector.name })}
      badge={
        dismissed
          ? { tone: "muted", label: t("aiElements.connector.dismissed") }
          : done
            ? { tone: "success", label: connector.noAuth ? t("aiElements.connector.enabled") : t("aiElements.connector.connected") }
            : { tone: "pending", label: t("aiElements.login.needsYou") }
      }
      description={
        dismissed
          ? t("aiElements.connector.noProblem")
          : done
            ? t("aiElements.login.resuming")
            : descriptionOf(connector, action, t)
      }
      error={done ? null : error}
      leading={
        <span className="grid size-8 place-items-center rounded-lg bg-background ring-1 ring-foreground/10">
          {connector.kind === "custom" ? (
            <CustomMcpIcon className="size-5" name={connector.name} src={connector.icon} url={connector.url} />
          ) : (
            <ConnectorIcon className="size-5" src={connector.icon} />
          )}
        </span>
      }
      resolved={done || dismissed}
      title={
        dismissed
          ? t("aiElements.connector.notConnected", { name: connector.name })
          : done
          ? t(connector.noAuth ? "aiElements.connector.titleEnabled" : "aiElements.connector.titleConnected", { name: connector.name })
          : t("aiElements.connector.verbName", { verb, name: connector.name })
      }
    >
      {connector.kind === "custom" && connector.url ? (
        <p
          className="truncate rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
          title={connector.url}
        >
          {connector.url}
        </p>
      ) : null}
    </RequestCard>
  )
}

function ComposioConnectorCard({
  connector,
  status,
  onDone,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  onDone?: () => void
}) {
  const composio = useComposio(status !== "done")
  const configured = composio.status?.configured === true
  const connected = composio.connections.some((app) => app.toolkit === connector.id)
  // App sem login: o clique só ativa; ao ficar ativo, retoma sem outro clique (uma vez só).
  const clicked = useRef(false)
  const resumed = useRef(false)
  useEffect(() => {
    if (!connector.noAuth || !clicked.current || !connected || resumed.current) return
    resumed.current = true
    onDone?.()
  }, [connector.noAuth, connected, onDone])
  return (
    <ConnectorLoginCardView
      connector={connector}
      status={status}
      action={configured ? "connect" : "configure"}
      connected={connected}
      busy={composio.busy !== null}
      error={composio.error ?? composio.listError}
      onAction={() => {
        if (!configured) return openSettingsModal("composio")
        clicked.current = true
        void composio.connect(connector.id, { noAuth: connector.noAuth })
      }}
      onDone={onDone}
    />
  )
}

function NativeConnectorCard({
  connector,
  status,
  onDone,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  onDone?: () => void
}) {
  const native = useNativeConnector(connector.id, status !== "done")
  const action = nativeConnectorAction(native.entry)
  // Conectou agora, pelo próprio card: retoma sem outro clique (uma vez só).
  const resumed = useRef(false)
  useEffect(() => {
    if (!native.justConnected || resumed.current) return
    resumed.current = true
    onDone?.()
  }, [native.justConnected, onDone])
  return (
    <ConnectorLoginCardView
      connector={connector}
      status={status}
      action={action}
      connected={native.connected}
      busy={native.busy}
      error={native.error}
      onAction={() =>
        action === "marketplace" ? requestMarketplace() : void native.connect()
      }
      onDone={onDone}
    />
  )
}

function CustomMcpCard({
  connector,
  status,
  onDone,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  onDone?: () => void
}) {
  const custom = useCustomMcpConnection(connector.url ?? "", status !== "done")
  const [dismissed, setDismissed] = useState(false)
  const resumed = useRef(false)
  useEffect(() => {
    if (!custom.justConnected || resumed.current) return
    resumed.current = true
    onDone?.()
  }, [custom.justConnected, onDone])
  return (
    <ConnectorLoginCardView
      connector={connector}
      status={status}
      action="connect"
      connected={custom.connected}
      busy={false}
      error={null}
      dismissed={dismissed && !custom.connected}
      onDismiss={() => setDismissed(true)}
      onAction={() =>
        requestCustomMcp({
          name: connector.name,
          url: connector.url ?? "",
          auth: connector.auth ?? "oauth",
        })
      }
      onDone={onDone}
    />
  )
}

export function ConnectorLoginCard({
  connector,
  status,
  onDone,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  onDone?: () => void
}) {
  if (connector.kind === "api")
    return <ApiConnectCard connector={connector} status={status} onDone={onDone} />
  if (connector.kind === "custom")
    return <CustomMcpCard connector={connector} status={status} onDone={onDone} />
  return connector.kind === "native" ? (
    <NativeConnectorCard connector={connector} status={status} onDone={onDone} />
  ) : (
    <ComposioConnectorCard connector={connector} status={status} onDone={onDone} />
  )
}

/** Cards antigos (só `composioToolkit`, sem dados de exibição) ainda abrem como Composio. */
export function legacyComposioConnector(toolkit: string): LoginConnector {
  return { kind: "composio", id: toolkit, name: toolkit, description: "", icon: null }
}
