"use client"

import { useState, type ReactNode } from "react"
import { CheckIcon, ExternalLinkIcon, FileDownIcon, XIcon } from "lucide-react"
import type { ScanFinding, TextDiff } from "@workspace/shared"
import { SHAPE_IDS } from "@workspace/ui/lib/avatar/geometry/shapes"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { FlowPanel } from "@/components/ai-elements/login/flow-panel"
import type {
  CatalogBotDetail,
  CatalogBotInstallInput,
  CatalogInstallView,
  PublishSkillForm,
  PublishSkillResult,
} from "@/lib/atlas-api"
import { useTranslations } from "@/lib/i18n/provider"
import { AgentAvatar } from "../agent-avatar"
import { bodyColors } from "../data"
import {
  CATEGORY_KEYS,
  categoryLabel,
  connectorStatusLabel,
  diffLabel,
  parseTagInput,
  scopeOptions,
} from "./catalog-state"
import { ToolChips } from "./catalog-views"

/** Cabeçalho comum das folhas (título, subtítulo e fechar). */
function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 px-4 pt-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      <Button aria-label="Fechar" onClick={onClose} size="icon-sm" type="button" variant="ghost">
        <XIcon aria-hidden />
      </Button>
    </div>
  )
}

function PanelBody({ children }: { children: ReactNode }) {
  return <div className="space-y-4 px-4 pt-4">{children}</div>
}

function PanelFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 px-4 pt-5 sm:flex-row sm:justify-end">{children}</div>
}

function FieldBlock({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

// ---- Instalar skill: escolher onde ----

export type SkillInstallFlowProps = {
  name: string
  version: string
  tools: readonly string[]
  bots: ReadonlyArray<{ id: string; name: string }>
  installs: readonly CatalogInstallView[]
  busy: boolean
  error?: string | null
  onClose: () => void
  onInstall: (botId: string | null) => void
  /** Só teste/preview: escopo inicial. */
  initialScope?: string | null
}

export function SkillInstallFlow({ name, version, tools, bots, installs, busy, error, onClose, onInstall, initialScope = null }: SkillInstallFlowProps) {
  const [scope, setScope] = useState<string | null>(initialScope)
  const options = scopeOptions(bots, installs)
  const current = installs.find((item) => item.botId === scope)
  const label = current?.updateAvailable ? "Atualizar" : current ? "Reinstalar" : "Instalar"
  return (
    <>
      <PanelHeader onClose={onClose} subtitle={`Versão ${version}. Escolha onde ela fica disponível.`} title={`Instalar ${name}`} />
      <PanelBody>
        <div aria-label="Onde instalar" className="divide-y overflow-hidden rounded-2xl border" role="radiogroup">
          {options.map((option) => {
            const selected = option.id === scope
            return (
              <button
                aria-checked={selected}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none",
                  selected && "bg-muted/60"
                )}
                disabled={busy}
                key={option.id ?? "account"}
                onClick={() => setScope(option.id)}
                role="radio"
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border",
                    selected ? "border-primary bg-primary text-primary-foreground" : "border-input"
                  )}
                >
                  {selected ? <CheckIcon className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  {option.hint ? <span className="block truncate text-xs text-muted-foreground">{option.hint}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        {tools.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Ela costuma usar (apenas dica):</p>
            <ToolChips limit={20} tools={tools} />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">Instalar não libera nenhuma ferramenta nova. Você pode editar ou apagar a habilidade depois.</p>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PanelBody>
      <PanelFooter>
        <Button disabled={busy} onClick={onClose} type="button" variant="outline">
          Cancelar
        </Button>
        <Button disabled={busy} onClick={() => onInstall(scope)} type="button">
          {busy ? "Instalando…" : label}
        </Button>
      </PanelFooter>
    </>
  )
}

// ---- Conflito: cópia editada ----

export type SkillConflictFlowProps = {
  name: string
  installedVersion: string
  catalogVersion: string
  diff: TextDiff
  busy: boolean
  error?: string | null
  onClose: () => void
  onChoose: (mode: "update" | "keep") => void
}

export function SkillConflictFlow({ name, installedVersion, catalogVersion, diff, busy, error, onClose, onChoose }: SkillConflictFlowProps) {
  return (
    <>
      <PanelHeader
        onClose={onClose}
        subtitle={`Você editou sua cópia (base v${installedVersion}). O catálogo está na v${catalogVersion}.`}
        title={`Atualizar ${name}?`}
      />
      <PanelBody>
        <div className="space-y-2 rounded-2xl border bg-muted/20 p-3">
          <p className="text-sm font-medium">O que muda na sua cópia</p>
          <p className="text-xs text-muted-foreground">{diffLabel(diff.added, diff.removed)}</p>
          {diff.preview.length > 0 ? (
            <pre className="max-h-48 overflow-auto rounded-xl bg-background p-2 font-mono text-xs leading-5" tabIndex={0}>
              {diff.preview.map((line, index) => (
                <span
                  className={cn("block whitespace-pre-wrap [overflow-wrap:anywhere]", line.startsWith("+") ? "text-success" : "text-red-400")}
                  key={`${index}-${line}`}
                >
                  {line}
                </span>
              ))}
            </pre>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">Atualizar troca o texto pelo do catálogo. A sua versão fica no histórico de revisões da habilidade.</p>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PanelBody>
      <PanelFooter>
        <Button disabled={busy} onClick={() => onChoose("keep")} type="button" variant="outline">
          Manter a minha
        </Button>
        <Button disabled={busy} onClick={() => onChoose("update")} type="button" variant="destructive">
          Atualizar e perder minhas mudanças
        </Button>
      </PanelFooter>
    </>
  )
}

// ---- Instalar agente ----

export type BotInstallFlowProps = {
  detail: CatalogBotDetail
  busy: boolean
  error?: string | null
  onClose: () => void
  onInstall: (input: CatalogBotInstallInput) => void
  /** Só teste/preview. */
  initial?: { name?: string; customize?: boolean; routines?: number[] }
}

export function BotInstallFlow({ detail, busy, error, onClose, onInstall, initial }: BotInstallFlowProps) {
  const { bot } = detail
  const [name, setName] = useState(initial?.name ?? bot.name)
  const [color, setColor] = useState(bot.color)
  const [shape, setShape] = useState(bot.shape)
  const [customize, setCustomize] = useState(initial?.customize ?? false)
  const [suggested, setSuggested] = useState(false)
  const [routines, setRoutines] = useState<number[]>(initial?.routines ?? [])
  const trimmed = name.replace(/\s+/g, " ").trim()
  const valid = trimmed.length > 0 && trimmed.length <= 40
  const toggle = (index: number) =>
    setRoutines((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b)))
  return (
    <>
      <PanelHeader onClose={onClose} subtitle="Revise antes de criar. Nada é conectado nem agendado sozinho." title={`Instalar ${bot.name}`} />
      <PanelBody>
        <div className="flex items-center gap-3">
          <AgentAvatar animated={false} bodyColor={color} id={bot.slug} shape={shape} size={56} />
          <div className="min-w-0 flex-1">
            <FieldBlock htmlFor="catalog-bot-name" label="Nome">
              <Input
                aria-invalid={!valid}
                autoComplete="off"
                id="catalog-bot-name"
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </FieldBlock>
          </div>
        </div>
        <div className="space-y-2">
          <Button aria-expanded={customize} className="-ml-2" onClick={() => setCustomize((value) => !value)} size="sm" type="button" variant="ghost">
            {customize ? "Ocultar aparência" : "Mudar aparência"}
          </Button>
          {customize ? (
            <div className="space-y-3 rounded-2xl border p-3">
              <div aria-label="Cor do agente" className="grid grid-cols-6 gap-2" role="group">
                {bodyColors.map((option) => (
                  <button
                    aria-label={option.name}
                    aria-pressed={color === option.value}
                    className={cn(
                      "size-7 rounded-full border border-border ring-offset-2 ring-offset-background transition",
                      color === option.value && "ring-2 ring-ring"
                    )}
                    key={option.value}
                    onClick={() => setColor(option.value)}
                    style={{ backgroundColor: option.value }}
                    type="button"
                  />
                ))}
              </div>
              <div aria-label="Formato do agente" className="grid grid-cols-6 gap-1.5" role="radiogroup">
                {SHAPE_IDS.map((item) => (
                  <button
                    aria-checked={shape === item}
                    aria-label={`Forma ${item}`}
                    className={cn("grid size-11 place-items-center rounded-2xl transition-colors hover:bg-muted", shape === item && "bg-muted")}
                    key={item}
                    onClick={() => setShape(item)}
                    role="radio"
                    type="button"
                  >
                    <AgentAvatar animated={false} bodyColor={color} id={item} shape={item} size={32} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <FieldBlock hint="Sem escolha, o agente usa o modelo padrão da sua conta." label="Modelo">
          <Select onValueChange={(next) => setSuggested(next === "suggested")} value={suggested ? "suggested" : "default"}>
            <SelectTrigger aria-label="Modelo do agente" className="w-full">
              <SelectValue>{(current) => (current === "suggested" ? `Sugerido: ${bot.suggestedModel}` : "Modelo padrão da conta")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Modelo padrão da conta</SelectItem>
              {bot.suggestedModel ? <SelectItem value="suggested">Sugerido: {bot.suggestedModel}</SelectItem> : null}
            </SelectContent>
          </Select>
        </FieldBlock>

        {detail.skills.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Habilidades que serão instaladas neste agente</p>
            <ul className="divide-y rounded-2xl border">
              {detail.skills.map((skill) => (
                <li className="flex items-center justify-between gap-3 px-3 py-2" key={skill.slug}>
                  <span className="min-w-0 truncate text-sm">{skill.name}</span>
                  <Badge className="shrink-0 font-normal" variant="secondary">
                    v{skill.version}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Elas não liberam nenhuma ferramenta nova.</p>
          </div>
        ) : null}

        {detail.connectors.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Conectores recomendados</p>
            <ul className="divide-y rounded-2xl border">
              {detail.connectors.map((connector) => (
                <li className="flex items-center justify-between gap-3 px-3 py-2" key={connector.id}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{connector.id}</span>
                    {connector.reason ? <span className="block text-xs text-muted-foreground">{connector.reason}</span> : null}
                  </span>
                  <Badge className="shrink-0" variant={connector.connected ? "default" : "outline"}>
                    {connectorStatusLabel(connector.connected)}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Nenhuma credencial vem no modelo. Você conecta as suas depois.</p>
          </div>
        ) : null}

        {bot.setupNotes.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {bot.setupNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {bot.starterRoutines.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Rotinas sugeridas (opcional)</legend>
            <p className="text-xs text-muted-foreground">Desmarcadas por padrão. Só as marcadas são criadas, e você pode desligar depois.</p>
            <ul className="divide-y rounded-2xl border">
              {bot.starterRoutines.map((routine, index) => (
                <li key={routine.name}>
                  <label className="flex min-h-12 cursor-pointer items-start gap-3 px-3 py-2">
                    <input
                      checked={routines.includes(index)}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      onChange={() => toggle(index)}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{routine.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{routine.cron}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PanelBody>
      <PanelFooter>
        <Button disabled={busy} onClick={onClose} type="button" variant="outline">
          Cancelar
        </Button>
        <Button
          disabled={busy || !valid}
          onClick={() =>
            onInstall({
              name: trimmed,
              color,
              shape,
              useSuggestedModel: suggested,
              routines,
            })
          }
          type="button"
        >
          {busy ? "Criando…" : "Criar agente"}
        </Button>
      </PanelFooter>
    </>
  )
}

// ---- Publicar ----

export type PublishFlowProps = {
  name: string
  /** Versão do catálogo de onde veio (atualização) ou null para habilidade nova. */
  baseVersion: string | null
  defaults: PublishSkillForm
  /** Resultado da varredura local do texto da skill. */
  findings: readonly ScanFinding[]
  busy: boolean
  error?: string | null
  result?: PublishSkillResult | null
  onClose: () => void
  onSubmit: (form: PublishSkillForm) => void
  onDownload?: (files: Array<{ path: string; content: string }>, slug: string) => void
}

export function PublishFlow({ name, baseVersion, defaults, findings, busy, error, result, onClose, onSubmit, onDownload }: PublishFlowProps) {
  const translator = useTranslations()
  const [version, setVersion] = useState(defaults.version)
  const [category, setCategory] = useState(defaults.category)
  const [tags, setTags] = useState(defaults.tags.join(", "))
  const [author, setAuthor] = useState(defaults.author)
  const [notes, setNotes] = useState(defaults.notes)
  const blocked = findings.some((item) => item.severity === "block")
  const review = findings.some((item) => item.severity === "review")
  const ready = !blocked && version.trim() && author.trim() && notes.trim() && category.trim()

  if (result?.mode === "pr") {
    return (
      <>
        <PanelHeader onClose={onClose} title="Pull request aberto" />
        <PanelBody>
          <p className="text-sm">
            Enviei <span className="font-mono">{name}</span> para revisão no catálogo. Quando for aprovada, ela aparece para todo mundo.
          </p>
          <a
            className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
            href={result.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            Ver o pull request #{result.number}
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        </PanelBody>
        <PanelFooter>
          <Button onClick={onClose} type="button">
            Pronto
          </Button>
        </PanelFooter>
      </>
    )
  }
  if (result?.mode === "package") {
    return (
      <>
        <PanelHeader onClose={onClose} title="Pacote pronto para enviar" />
        <PanelBody>
          <p className="text-sm text-muted-foreground">{result.message}</p>
          <ul className="divide-y rounded-2xl border">
            {result.files.map((file) => (
              <li className="px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]" key={file.path}>
                {file.path}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Baixe o pacote, copie as pastas para um fork do catálogo e abra o pull request pelo GitHub.</p>
        </PanelBody>
        <PanelFooter>
          <a
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-3xl border px-3 text-sm font-medium hover:bg-muted"
            href={result.newPrUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Abrir página do PR
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
          <Button onClick={() => onDownload?.(result.files, result.slug)} type="button">
            <FileDownIcon aria-hidden /> Baixar pacote (.zip)
          </Button>
        </PanelFooter>
      </>
    )
  }

  return (
    <>
      <PanelHeader
        onClose={onClose}
        subtitle={baseVersion ? `Atualização da v${baseVersion} do catálogo. O PR leva a diferença.` : "Abre um pull request no catálogo com o texto da habilidade."}
        title={`Publicar ${name}`}
      />
      <PanelBody>
        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>Não dá para publicar</AlertTitle>
            <AlertDescription>A habilidade tem instruções que o catálogo não aceita (por exemplo, enviar dados para fora, desligar aprovações ou chaves no texto). Ajuste e tente de novo.</AlertDescription>
          </Alert>
        ) : review ? (
          <Alert variant="warning">
            <AlertTitle>Alguns trechos serão revisados à mão</AlertTitle>
            <AlertDescription>Comandos de rede ou leitura do cofre pedem uma olhada extra de quem revisa o PR.</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <FieldBlock htmlFor="publish-version" label="Versão">
            <Input autoComplete="off" className="font-mono" id="publish-version" inputMode="decimal" onChange={(event) => setVersion(event.target.value)} value={version} />
          </FieldBlock>
          <FieldBlock label="Categoria">
            <Select onValueChange={(next) => setCategory(String(next))} value={category}>
              <SelectTrigger aria-label="Categoria" className="w-full">
                <SelectValue>{(current) => categoryLabel(String(current), translator)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.keys(CATEGORY_KEYS).map((id) => (
                  <SelectItem key={id} value={id}>
                    {categoryLabel(id, translator)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldBlock>
        </div>
        <FieldBlock htmlFor="publish-author" label="Autor">
          <Input autoComplete="off" id="publish-author" maxLength={80} onChange={(event) => setAuthor(event.target.value)} value={author} />
        </FieldBlock>
        <FieldBlock hint="Separadas por vírgula. Até 10." htmlFor="publish-tags" label="Tags">
          <Input autoComplete="off" id="publish-tags" onChange={(event) => setTags(event.target.value)} placeholder="roblox, luau" value={tags} />
        </FieldBlock>
        <FieldBlock hint="Vai para o histórico de versões e para o PR." htmlFor="publish-notes" label="O que mudou">
          <Textarea id="publish-notes" maxLength={500} onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} />
        </FieldBlock>
        <p className="text-xs text-muted-foreground">Só o texto da habilidade é enviado. Segredos, conversas e dados da conta nunca entram.</p>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </PanelBody>
      <PanelFooter>
        <Button disabled={busy} onClick={onClose} type="button" variant="outline">
          Cancelar
        </Button>
        <Button
          disabled={busy || !ready}
          onClick={() => onSubmit({ version: version.trim(), category: category.trim(), tags: parseTagInput(tags), notes: notes.trim(), author: author.trim() })}
          type="button"
        >
          {busy ? "Enviando…" : "Publicar no marketplace"}
        </Button>
      </PanelFooter>
    </>
  )
}

// ---- Folhas (diálogo no desktop, folha de baixo no celular) ----

export function CatalogPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <FlowPanel description={description} onOpenChange={onOpenChange} open={open} title={title}>
      {children}
    </FlowPanel>
  )
}
