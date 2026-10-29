"use client"
import { useState } from "react"
import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react"
import type { ApiProposal } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card"
import { cn } from "@workspace/ui/lib/utils"
import { CopyButton } from "@/components/ai-elements/dev-session/parts"
import { FlowPanel } from "@/components/ai-elements/login/flow-panel"
import { ApiGroupsPicker } from "@/components/ai-elements/connectors/api-groups-picker"
import type { ApiConnectForm } from "@/hooks/use-api-connection"
import { anotherAccountHint } from "@/lib/connector-accounts"
import { useTranslations } from "@/lib/i18n/provider"
import { defaultTranslator, type Translator } from "@/lib/i18n/translator"

/** O que o usuário digitou; vive só no componente até o envio ao servidor. */
export type ApiConnectValues = {
  clientId: string
  clientSecret: string
  apiKey: string
  allowedTags: string[]
}

/** Nome para a interface: tira o " API" do fim do título da especificação ("Bling API" vira "Bling"). */
export function apiDisplayName(name: string) {
  const short = name.replace(/\s+API$/i, "").trim()
  return short || name
}

/** Grupos com leitura, na ordem da especificação. */
export function readableGroups(proposal: ApiProposal) {
  return proposal.groups.filter((group) => group.read > 0)
}

/** Faixas de palavras de negócio, da mais à menos importante (texto sem acento, minúsculo). */
const GROUP_TIERS: RegExp[][] = [
  [/pedido/, /venda/],
  [/produto/],
  [/estoque/],
  [/contato/, /cliente/],
  [/conta/, /pagar/, /receber/],
  [/nota/, /fiscal|fiscais/],
  [/financ/, /caixa/, /banco/],
]

const plainText = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

function groupTier(tag: string) {
  const text = plainText(tag)
  for (let tier = 0; tier < GROUP_TIERS.length; tier++) {
    const hits = GROUP_TIERS[tier]!.filter((word) => word.test(text)).length
    if (hits > 0) return { tier, hits }
  }
  return { tier: GROUP_TIERS.length, hits: 0 }
}

/**
 * Grupos para a frase-resumo: o melhor de cada faixa de negócio (pedidos/vendas,
 * produtos, estoque, contatos, contas, notas fiscais, financeiro) na ordem das
 * faixas, depois os demais pela faixa; desempate por menos palavras no nome,
 * mais consultas e a ordem da especificação.
 */
export function summaryGroups(proposal: ApiProposal) {
  const ranked = readableGroups(proposal)
    .map((group, order) => ({ group, order, ...groupTier(group.tag) }))
    .sort((a, b) => a.tier - b.tier || b.hits - a.hits || a.group.tag.length - b.group.tag.length || b.group.read - a.group.read || a.order - b.order)
  const firstOfTier = ranked.filter((item, index) => ranked.findIndex((other) => other.tier === item.tier) === index)
  return [...firstOfTier, ...ranked.filter((item) => !firstOfTier.includes(item))].map((item) => item.group)
}

/** "A, B, C e mais 2" (grupos de negócio mais conhecidos primeiro). */
export function groupListText(proposal: ApiProposal, max = 3, { t }: Translator = defaultTranslator) {
  const top = summaryGroups(proposal)
    .slice(0, max)
    .map((group) => group.tag.replace(/\s+[-–]\s+/g, t("aiElements.api.groupOf")).toLowerCase())
  const rest = readableGroups(proposal).length - top.length
  if (top.length === 0) return t("aiElements.api.groupsNone")
  if (rest > 0) return t("aiElements.api.groupsMore", { list: top.join(", "), count: rest })
  return top.length > 1 ? t("aiElements.api.groupsAnd", { list: top.slice(0, -1).join(", "), last: top.at(-1)! }) : top[0]!
}

/** Precisa digitar credencial? (sem autenticação vai direto ao acesso). */
export function needsCredentials(proposal: ApiProposal) {
  return proposal.authKind !== "none"
}

/** Pode avançar? OAuth2 pede client id e secret; chave/token pedem o valor. */
export function credentialsReady(proposal: ApiProposal, values: ApiConnectValues) {
  if (proposal.authKind === "oauth2")
    return values.clientId.trim() !== "" && values.clientSecret.trim() !== ""
  if (proposal.authKind === "none") return true
  return values.apiKey.trim() !== ""
}

/** Pode conectar? Credenciais prontas e ao menos um grupo liberado. */
export function apiConnectReady(proposal: ApiProposal, values: ApiConnectValues) {
  return values.allowedTags.length > 0 && credentialsReady(proposal, values)
}

/** URL que só quebra de linha nos separadores (/ . ? & = -), nunca no meio de uma palavra. */
export function breakableUrl(url: string) {
  return url
    .split(/(?<=[/.?&=-])/)
    .flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]))
}

export function RedirectUrlPill({ url }: { url: string }) {
  const { t } = useTranslations()
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg bg-foreground/[0.06] py-1 pr-1 pl-2.5">
      <code
        className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:normal] [word-break:normal]"
        title={url}
      >
        {breakableUrl(url)}
      </code>
      <CopyButton label={t("aiElements.api.copyRedirect")} text={url} />
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "password",
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: "text" | "password"
  disabled?: boolean
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        type={type}
        value={value}
      />
    </label>
  )
}

function CredentialsStep({
  proposal,
  values,
  set,
  disabled,
  helpOpen,
  onHelp,
}: {
  proposal: ApiProposal
  values: ApiConnectValues
  set: (patch: Partial<ApiConnectValues>) => void
  disabled: boolean
  helpOpen: boolean
  onHelp: (open: boolean) => void
}) {
  const { t } = useTranslations()
  const oauth = proposal.authKind === "oauth2"
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {oauth && proposal.redirectUrl ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <RedirectUrlPill url={proposal.redirectUrl} />
          <p className="m-0 text-xs text-muted-foreground">
            {t("aiElements.api.registerRedirect")}
          </p>
        </div>
      ) : null}
      {oauth ? (
        <>
          <Field disabled={disabled} label="Client ID" onChange={(clientId) => set({ clientId })} type="text" value={values.clientId} />
          <Field disabled={disabled} label="Client secret" onChange={(clientSecret) => set({ clientSecret })} value={values.clientSecret} />
        </>
      ) : (
        <Field
          disabled={disabled}
          label={proposal.authKind === "bearer" ? t("aiElements.api.accessToken") : t("aiElements.api.key")}
          onChange={(apiKey) => set({ apiKey })}
          value={values.apiKey}
        />
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <button
          aria-expanded={helpOpen}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          onClick={() => onHelp(!helpOpen)}
          type="button"
        >
          {t("aiElements.api.whereFind")}
          <ChevronDownIcon aria-hidden className={cn("size-3.5 transition-transform", helpOpen && "rotate-180")} />
        </button>
        {helpOpen ? (
          <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
            <p className="m-0">
              {oauth
                ? t("aiElements.api.helpOauth", { domain: proposal.domain })
                : t("aiElements.api.helpKey", { domain: proposal.domain })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Passo a passo da conexão em uma folha de baixo: 1) credenciais, 2) acesso.
 * Só aqui o usuário digita segredo; ele vai direto ao servidor (cofre).
 */
export function ApiConnectSheet({
  open,
  onOpenChange,
  ...flow
}: ApiConnectFlowProps & { open: boolean }) {
  const { t } = useTranslations()
  return (
    <FlowPanel
      description={t("aiElements.api.sheetDescription")}
      onOpenChange={onOpenChange}
      open={open}
      title={t("aiElements.api.sheetTitle", { name: apiDisplayName(flow.proposal.name) })}
    >
      <ApiConnectFlow onOpenChange={onOpenChange} {...flow} />
    </FlowPanel>
  )
}

type ApiConnectFlowProps = {
  proposal: ApiProposal
  onOpenChange: (open: boolean) => void
  busy: boolean
  error?: string | null
  onSubmit: (form: ApiConnectForm) => void
  /** Outra conta da mesma API: no passo de autorizar, avisa para sair da conta atual no site do serviço. */
  anotherAccount?: boolean
  /** Só teste: estado inicial. */
  initial?: Partial<ApiConnectValues> & { step?: 1 | 2; helpOpen?: boolean; customize?: boolean }
}

/** Conteúdo da folha (passos, campos e botões); separado para testar sem portal. */
export function ApiConnectFlow({ proposal, onOpenChange, busy, error, onSubmit, initial, anotherAccount = false }: ApiConnectFlowProps) {
  const translator = useTranslations()
  const { t } = translator
  const credentials = needsCredentials(proposal)
  const total = credentials ? 2 : 1
  const [step, setStep] = useState<1 | 2>(initial?.step ?? (credentials ? 1 : 2))
  const [helpOpen, setHelpOpen] = useState(initial?.helpOpen ?? false)
  const [customize, setCustomize] = useState(initial?.customize ?? false)
  const [values, setValues] = useState<ApiConnectValues>({
    clientId: initial?.clientId ?? "",
    clientSecret: initial?.clientSecret ?? "",
    apiKey: initial?.apiKey ?? "",
    allowedTags: initial?.allowedTags ?? readableGroups(proposal).map((group) => group.tag),
  })
  const set = (patch: Partial<ApiConnectValues>) => setValues((current) => ({ ...current, ...patch }))
  const oauth = proposal.authKind === "oauth2"
  const position = credentials ? step : 1
  const submit = () =>
    onSubmit({
      allowedTags: values.allowedTags,
      ...(oauth ? { clientId: values.clientId.trim(), clientSecret: values.clientSecret.trim() } : {}),
      ...(credentials && !oauth ? { apiKey: values.apiKey.trim() } : {}),
    })
  return (
    <>
        <div className="flex items-center gap-2 px-4 pt-4">
          {credentials && step === 2 ? (
            <Button aria-label={t("common.back")} disabled={busy} onClick={() => setStep(1)} size="icon-sm" type="button" variant="ghost">
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <p className="m-0 flex-1 text-xs text-muted-foreground">
            {t("aiElements.api.stepOf", { position, total })}
          </p>
          <Button disabled={busy} onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-4 px-4 pt-2 pb-2">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-base font-semibold">
              {step === 1 && credentials ? t("aiElements.api.stepCredentials") : t("aiElements.api.stepAccess")}
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              {step === 1 && credentials
                ? t("aiElements.api.credentialsText", { name: apiDisplayName(proposal.name) })
                : t("aiElements.api.accessText")}
            </p>
          </div>
          {step === 1 && credentials ? (
            <CredentialsStep
              disabled={busy}
              helpOpen={helpOpen}
              onHelp={setHelpOpen}
              proposal={proposal}
              set={set}
              values={values}
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="m-0 text-sm">
                {t("aiElements.api.allRead", { groups: groupListText(proposal, 3, translator) })}
              </p>
              <button
                aria-expanded={customize}
                className="-ml-1 inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
                onClick={() => setCustomize((value) => !value)}
                type="button"
              >
                {t("aiElements.api.customize")}
                <ChevronDownIcon aria-hidden className={cn("size-3.5 transition-transform", customize && "rotate-180")} />
              </button>
              {customize ? (
                <ApiGroupsPicker
                  disabled={busy}
                  groups={proposal.groups}
                  onChange={(allowedTags) => set({ allowedTags })}
                  selected={values.allowedTags}
                />
              ) : (
                <p className="m-0 text-xs text-muted-foreground">{t("aiElements.api.writeSoon")}</p>
              )}
            </div>
          )}
          {anotherAccount && oauth && !(step === 1 && credentials) ? (
            <p className="m-0 text-xs text-muted-foreground">{anotherAccountHint()}</p>
          ) : null}
          {error ? (
            <p className="m-0 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="px-4 pt-2">
          {step === 1 && credentials ? (
            <Button className={cn("w-full", REQUEST_PRIMARY_CLASS)} disabled={!credentialsReady(proposal, values)} onClick={() => setStep(2)} type="button">
              {t("aiElements.api.continue")}
            </Button>
          ) : (
            <Button className={cn("w-full", REQUEST_PRIMARY_CLASS)} disabled={busy || !apiConnectReady(proposal, values)} onClick={submit} type="button">
              {busy ? t("aiElements.api.connecting") : oauth ? t("aiElements.api.authorizeOn", { name: apiDisplayName(proposal.name) }) : t("aiElements.api.connect")}
            </Button>
          )}
        </div>
    </>
  )
}
