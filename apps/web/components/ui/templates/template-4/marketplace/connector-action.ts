import type { McpConnectionView } from "@workspace/shared"
import type { McpCatalogItem } from "@/lib/atlas-api"
import { defaultTranslator, type Translator } from "@/lib/i18n/translator"

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
  translator: { t } = defaultTranslator,
}: {
  entry?: McpCatalogItem
  connection?: McpConnectionView
  secretBoxReady: boolean
  busy: boolean
  translator?: Translator
}): ConnectorAction {
  if (entry?.availability === "coming_soon") {
    return { label: t("marketplace.action.soon"), connected: false, disabled: true }
  }
  if (busy) return { label: t("marketplace.action.connecting"), connected: false, disabled: true }
  if (connection?.status === "connected") {
    return { label: t("marketplace.action.added"), connected: true, disabled: false }
  }
  const blocked = !secretBoxReady && !connection
  if (entry?.authType === "oauth" && !entry.oauthReady && !entry.apiKey) {
    return {
      label: t("marketplace.action.needsSetup"),
      connected: false,
      disabled: true,
      title: t("marketplace.action.needsSetupHint", { vars: entry.oauthMissingEnv.join(t("marketplace.action.and")) }),
    }
  }
  return {
    label: connection ? t("marketplace.action.reconnect") : t("marketplace.action.add"),
    connected: false,
    disabled: blocked,
  }
}
