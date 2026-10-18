import type { McpConnectionView } from "@workspace/shared"
import type { McpCatalogItem } from "@/lib/atlas-api"

export type ConnectorAction = {
  label: string
  connected: boolean
  disabled: boolean
  /** Dica no hover (ex.: env faltando para o login OAuth). */
  title?: string
}

/** Estado do botão Adicionar/Reconectar, igual em card, destaque e página. */
export function connectorAction({
  entry,
  connection,
  secretBoxReady,
  busy,
}: {
  entry?: McpCatalogItem
  connection?: McpConnectionView
  secretBoxReady: boolean
  busy: boolean
}): ConnectorAction {
  if (entry?.availability === "coming_soon") {
    return { label: "Em breve", connected: false, disabled: true }
  }
  if (busy) return { label: "Conectando…", connected: false, disabled: true }
  if (connection?.status === "connected") {
    return { label: "Adicionado", connected: true, disabled: false }
  }
  const blocked = !secretBoxReady && !connection
  if (entry?.authType === "oauth" && !entry.oauthReady && !entry.apiKey) {
    return {
      label: "Requer configuração",
      connected: false,
      disabled: true,
      title: `Defina ${entry.oauthMissingEnv.join(" e ")} no .env da API e do worker`,
    }
  }
  return {
    label: connection ? "Reconectar" : "Adicionar",
    connected: false,
    disabled: blocked,
  }
}
