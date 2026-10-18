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

function descriptionOf(connector: LoginConnector, action: ConnectorCardAction) {
  if (connector.kind === "custom" && action === "connect" && !connector.description)
    return "Servidor MCP personalizado. Você entra com a sua conta no próprio serviço; a senha não passa pelo agente."
  if (action === "configure")
    return "Configure sua chave do Composio para conectar este app. Sua senha não passa pelo agente."
  return (
    connector.description ||
    (connector.noAuth
      ? "Este app não precisa de login. Ative para o agente usar."
      : null) ||
    "Conecte sua conta para o agente usar este app. Sua senha não passa pelo agente nem pela VM."
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
  const done = status === "done"
  const verb = connector.noAuth
    ? "Ativar"
    : connector.reconnect
      ? "Reconectar"
      : "Conectar"
  const label =
    action === "configure"
      ? "Configurar Composio"
      : action === "marketplace"
        ? "Informar chave no Marketplace"
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
              {busy ? (connector.noAuth ? "Ativando…" : "Conectando…") : label}
            </Button>
          )}
          {!connected && onDismiss && (
            <Button disabled={busy} onClick={onDismiss} size="sm" type="button" variant="ghost">
              Agora não
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
            Retomar tarefa
          </Button>
          )}
        </>
      }
      aria-label={`${verb} ${connector.name}`}
      badge={
        dismissed
          ? { tone: "muted", label: "Dispensado" }
          : done
            ? { tone: "success", label: connector.noAuth ? "Ativado" : "Conectado" }
            : { tone: "pending", label: "Precisa de você" }
      }
      description={
        dismissed
          ? "Sem problemas. Você pode conectar depois em Conectores."
          : done
            ? "Retomando de onde parou."
            : descriptionOf(connector, action)
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
          ? `${connector.name} não conectado`
          : done
          ? `${connector.name} ${connector.noAuth ? "ativado" : "conectado"}`
          : `${verb} ${connector.name}`
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
