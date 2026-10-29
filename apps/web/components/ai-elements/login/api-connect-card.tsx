"use client"
import { useEffect, useRef, useState } from "react"
import type { ApiProposal, LoginConnector } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card"
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon"
import { ApiConnectSheet, apiDisplayName, groupListText } from "@/components/ai-elements/login/api-connect-sheet"
import { useApiConnect } from "@/hooks/use-api-connection"
import { requestMarketplace } from "@/lib/open-marketplace"
import { apiAuthLabel } from "@/lib/shared-labels"
import { useTranslations } from "@/lib/i18n/provider"

function specHost(proposal: ApiProposal) {
  try {
    return new URL(proposal.specUrl).hostname
  } catch {
    return proposal.domain
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  )
}

/**
 * Card "Conectar API" compacto: o que o bot vai poder consultar e dois
 * botões. Domínio, autenticação e contagens ficam em "Detalhes"; credenciais e
 * grupos ficam na folha aberta por "Conectar". Nada é criado até a folha ser
 * concluída.
 */
export function ApiConnectCardView({
  connector,
  status = "pending",
  connected,
  dismissed = false,
  detailsOpen = false,
  onConnect,
  onDismiss,
  onDone,
  onManage,
  canResume = false,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  connected: boolean
  dismissed?: boolean
  /** Só teste: começa com os detalhes abertos. */
  detailsOpen?: boolean
  onConnect: () => void
  onDismiss?: () => void
  onDone?: () => void
  onManage?: () => void
  /** Conectada mas o run ainda espera: mostra "Retomar". */
  canResume?: boolean
}) {
  const translator = useTranslations()
  const { t, tn } = translator
  const proposal = connector.api
  const [details, setDetails] = useState(detailsOpen)
  if (!proposal) return null
  const label = apiDisplayName(proposal.name)
  const done = status === "done" || connected
  const icon = (
    <span className="grid size-8 place-items-center rounded-lg bg-background ring-1 ring-foreground/10">
      <CustomMcpIcon className="size-5" name={label} url={proposal.baseUrl} />
    </span>
  )
  if (done) {
    return (
      <RequestCard
        aria-label={t("aiElements.api.connectedLabel", { name: label })}
        className="scroll-mt-20"
        headerAction={
          <>
            {canResume && status !== "done" ? (
              <Button className={REQUEST_PRIMARY_CLASS} onClick={onDone} size="sm" type="button">
                {t("aiElements.api.resume")}
              </Button>
            ) : null}
            {onManage ? (
              <Button onClick={onManage} size="sm" type="button" variant="ghost">
                {t("aiElements.api.manage")}
              </Button>
            ) : null}
          </>
        }
        leading={icon}
        resolved
        title={t("aiElements.api.connectedReadOnly", { name: label })}
      />
    )
  }
  return (
    <RequestCard
      actions={
        dismissed ? undefined : (
          <>
            <Button className={REQUEST_PRIMARY_CLASS} onClick={onConnect} size="sm" type="button">
              {t("aiElements.api.connect")}
            </Button>
            {onDismiss ? (
              <Button onClick={onDismiss} size="sm" type="button" variant="secondary">
                {t("aiElements.connector.notNow")}
              </Button>
            ) : null}
          </>
        )
        }
        aria-label={t("aiElements.api.connectName", { name: label })}
        badge={dismissed ? { tone: "muted", label: t("aiElements.connector.dismissed") } : { tone: "muted", label: t("aiElements.api.readOnly") }}
        className="scroll-mt-20"
        description={
          dismissed
            ? t("aiElements.connector.noProblem")
            : t("aiElements.api.description", { groups: groupListText(proposal, 3, translator) })
        }
        leading={icon}
        resolved={dismissed}
        title={dismissed ? t("aiElements.api.notConnected", { name: label }) : t("aiElements.api.connectName", { name: label })}
        trailing={
          dismissed ? undefined : (
            <Button aria-expanded={details} onClick={() => setDetails((value) => !value)} size="sm" type="button" variant="ghost">
              {t("aiElements.api.details")}
            </Button>
          )
        }
      >
        {proposal.foundByBot && !dismissed ? (
          <p className="m-0 text-xs text-muted-foreground">
            {t("aiElements.api.foundByBot")} · <span className="font-medium text-foreground">{specHost(proposal)}</span>
          </p>
        ) : null}
        {details && !dismissed ? (
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <Fact label={t("aiElements.api.factSite")}>
              <span className="font-mono">{proposal.domain}</span>
            </Fact>
            <Fact label={t("aiElements.api.factAccess")}>
              {apiAuthLabel(proposal.authKind, translator)}
              {proposal.authDetail ? ` · ${proposal.authDetail}` : ""}
            </Fact>
            <Fact label={t("aiElements.api.factWhat")}>
              {t("aiElements.api.whatValue", { actions: proposal.operationCount === 0 ? t("aiElements.api.actionCountNone") : tn("aiElements.api.actionCount", proposal.operationCount), read: proposal.readCount })}
            </Fact>
            {proposal.crossHost ? (
              <>
                <dt className="text-warning">{t("aiElements.api.warning")}</dt>
                <dd className="m-0 text-warning">
                  {t("aiElements.api.crossHost")}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </RequestCard>
    )
}

/** Container: liga o card e a folha ao servidor e retoma o run quando a conexão fica ativa (uma vez só). */
export function ApiConnectCard({
  connector,
  status,
  onDone,
}: {
  connector: LoginConnector
  status?: "pending" | "done"
  onDone?: () => void
}) {
  const proposal = connector.api as ApiProposal
  const api = useApiConnect(proposal, status !== "done")
  const [dismissed, setDismissed] = useState(false)
  const [sheet, setSheet] = useState(false)
  const resumed = useRef(false)
  useEffect(() => {
    if (!api.justConnected || resumed.current) return
    resumed.current = true
    setSheet(false)
    onDone?.()
  }, [api.justConnected, onDone])
  return (
    <>
      <ApiConnectCardView
        canResume={api.connected && !resumed.current}
        connected={api.connected}
        connector={connector}
        dismissed={dismissed && !api.connected}
        onConnect={() => setSheet(true)}
        onDismiss={() => setDismissed(true)}
        onDone={onDone}
        onManage={() => requestMarketplace()}
        status={status}
      />
      {sheet && !api.connected ? (
        <ApiConnectSheet
          busy={api.busy}
          error={api.error}
          onOpenChange={(open) => !api.busy && setSheet(open)}
          onSubmit={(form) => void api.connect(form)}
          open
          proposal={proposal}
        />
      ) : null}
    </>
  )
}
