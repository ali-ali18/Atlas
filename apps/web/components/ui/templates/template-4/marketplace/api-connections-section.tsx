"use client"

import type { ApiConnectionView } from "@workspace/shared"
import { CheckIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { accountCountText } from "@/lib/connector-accounts"
import { useTranslations } from "@/lib/i18n/provider"
import { apiAuthLabel } from "@/lib/shared-labels"
import { defaultTranslator, type Translator } from "@/lib/i18n/translator"
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon"

/** Texto curto do estado da conexão para a lista. */
export function apiConnectionStatusLabel(item: Pick<ApiConnectionView, "status" | "lastError">, { t }: Translator = defaultTranslator) {
  if (item.status === "connected") return t("marketplace.api.status.connected")
  if (item.status === "disabled") return t("marketplace.api.status.disabled")
  if (item.status === "error") return item.lastError ? t("marketplace.api.status.errorWith", { message: item.lastError }) : t("marketplace.api.status.error")
  return item.lastError ? t("marketplace.api.status.pendingWith", { message: item.lastError }) : t("marketplace.api.status.pending")
}

export { apiAuthLabel }

/** Grupos com consultas de leitura (os únicos que podem ser liberados nesta etapa). */
export function readableApiGroups(item: Pick<ApiConnectionView, "groups">) {
  return item.groups.filter((group) => group.read > 0)
}

/** Resumo do acesso: "Leitura · 2 de 3 grupos". */
export function apiAccessSummary(item: Pick<ApiConnectionView, "groups" | "allowedTags">, { t, tn }: Translator = defaultTranslator) {
  const readable = readableApiGroups(item).length
  if (readable === 0) return t("marketplace.api.accessNone", { allowed: item.allowedTags.length })
  return tn("marketplace.api.access", readable, { allowed: item.allowedTags.length })
}

/** Item de `?marketplace=conectores&item=a.<id>`: o detalhe de uma conexão de API. */
export const API_ITEM_PREFIX = "a."
export const apiItemKey = (id: string) => `${API_ITEM_PREFIX}${id}`

/** Cartão de uma API conectada, no mesmo formato dos conectores MCP; abre a página da conexão. */
export function ApiConnectionCard({ item, accountLabel, accountCount = 1, onOpen }: { item: ApiConnectionView; /** Apelido da conta (uma conta só). */ accountLabel?: string | null; /** Contas do mesmo serviço: com mais de uma, o subtítulo é "N contas". */ accountCount?: number; onOpen: () => void }) {
  const translator = useTranslations()
  const { t } = translator
  const connected = item.status === "connected"
  return (
    <div className="relative flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/45">
      <button
        aria-label={accountCount > 1 || !accountLabel ? t("marketplace.api.viewDetails", { name: item.name }) : t("marketplace.api.viewDetailsAccount", { name: item.name, account: accountLabel })}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={onOpen}
        type="button"
      />
      <span className="pointer-events-none grid size-12 shrink-0 place-items-center rounded-2xl border bg-background">
        <CustomMcpIcon className="size-7" name={item.name} url={item.baseUrl} />
      </span>
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="truncate text-xs text-muted-foreground" title={apiConnectionStatusLabel(item, translator)}>
          {connected ? (
            <>
              {accountCount > 1 ? `${accountCountText(accountCount)} · ` : accountLabel ? `${accountLabel} · ` : "API · "}
              <span className="font-mono">{item.domain}</span>
            </>
          ) : (
            `${accountLabel ? `${accountLabel} · ` : ""}${apiConnectionStatusLabel(item, translator)}`
          )}
        </p>
      </div>
      <Button
        className="relative z-10 h-7 shrink-0 rounded-full px-3 text-xs"
        onClick={onOpen}
        size="sm"
        title={`${apiAuthLabel(item.authKind, translator)} · ${apiAccessSummary(item, translator)}`}
        type="button"
        variant="secondary"
      >
        {connected ? <CheckIcon className="size-3.5" /> : null}
        {connected ? t("marketplace.api.connected") : t("marketplace.action.reconnect")}
      </Button>
    </div>
  )
}
