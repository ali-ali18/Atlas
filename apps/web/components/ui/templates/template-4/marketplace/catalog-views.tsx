"use client"

import type { ReactNode } from "react"
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react"
import { resolveBotProposalColor, type CatalogBotEntry, type CatalogChangelogEntry } from "@workspace/shared"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import type {
  CatalogBotDetail,
  CatalogInstallView,
  CatalogSkillDetail,
  CatalogSkillItem,
} from "@/lib/atlas-api"
import { SkillMarkdownPreview } from "@/components/settings/sections/skills/skill-markdown-preview"
import { AgentAvatar } from "../agent-avatar"
import {
  categoriesOf,
  categoryLabel,
  connectorStatusLabel,
  installSummary,
  toolLabel,
} from "./catalog-state"

const ALL = "all"
const MAX_CHIPS = 3

/** Chips das ferramentas que a habilidade costuma usar (só dica, nunca permissão). */
export function ToolChips({
  tools,
  limit = MAX_CHIPS,
}: {
  tools: readonly string[]
  limit?: number
}) {
  if (tools.length === 0) return null
  const shown = tools.slice(0, limit)
  const extra = tools.length - shown.length
  return (
    <ul aria-label="Ferramentas sugeridas" className="flex flex-wrap gap-1">
      {shown.map((tool) => (
        <li key={tool}>
          <Badge className="font-normal" variant="outline">
            {toolLabel(tool)}
          </Badge>
        </li>
      ))}
      {extra > 0 ? (
        <li>
          <Badge className="font-normal" variant="outline">
            +{extra}
          </Badge>
        </li>
      ) : null}
    </ul>
  )
}

export function CategorySelect({
  categories,
  category,
  onCategory,
}: {
  categories: ReturnType<typeof categoriesOf>
  category: string
  onCategory: (category: string) => void
}) {
  if (categories.length === 0) return null
  return (
    <Select
      onValueChange={(next) => onCategory(next === ALL ? "" : String(next))}
      value={category || ALL}
    >
      <SelectTrigger
        aria-label="Filtrar por categoria"
        className="h-8 w-fit min-w-40 text-xs"
        size="sm"
      >
        <SelectValue>
          {(current) =>
            current === ALL ? "Todas as categorias" : categoryLabel(String(current))
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Todas as categorias</SelectItem>
        {categories.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.label} ({item.count})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ItemIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-2xl border bg-background">
      {children}
    </span>
  )
}

function ListState({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
}: {
  loading: boolean
  error: string | null
  empty: boolean
  emptyText: string
  onRetry?: () => void
}) {
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton className="h-20 rounded-xl" key={index} />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Não foi possível carregar</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
        {onRetry ? (
          <Button className="mt-2" onClick={onRetry} size="sm" type="button" variant="outline">
            Tentar de novo
          </Button>
        ) : null}
      </Alert>
    )
  }
  if (empty) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
  return null
}

function InstallButton({
  label,
  done,
  update,
  onClick,
  name,
}: {
  label: string
  done?: boolean
  update?: boolean
  onClick: () => void
  name: string
}) {
  return (
    <Button
      aria-label={`${label} ${name}`}
      className="relative z-10 mt-0.5 h-7 shrink-0 rounded-full px-3 text-xs md:col-span-2 md:mt-0 md:justify-self-end"
      onClick={onClick}
      size="sm"
      type="button"
      variant={update ? "default" : "secondary"}
    >
      {done ? <CheckIcon className="size-3.5" /> : update ? <RefreshCwIcon className="size-3.5" /> : null}
      {label}
    </Button>
  )
}

export function skillActionLabel(installs: readonly CatalogInstallView[]): {
  label: string
  done: boolean
  update: boolean
} {
  const summary = installSummary(installs)
  if (summary.kind === "update") return { label: "Atualizar", done: false, update: true }
  if (summary.kind === "installed") return { label: "Instalada", done: true, update: false }
  return { label: "Instalar", done: false, update: false }
}

function SkillCard({
  skill,
  onOpen,
  onInstall,
}: {
  skill: CatalogSkillItem
  onOpen: () => void
  onInstall: () => void
}) {
  const action = skillActionLabel(skill.installs)
  return (
    <li className="relative grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 py-4 md:grid-cols-[3rem_minmax(0,1fr)] md:grid-rows-[1fr_auto] md:rounded-2xl md:border md:bg-card/40 md:p-4 md:transition-colors md:hover:bg-muted/40">
      <button
        aria-label={`Ver detalhes de ${skill.name}`}
        className="absolute inset-0 md:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={onOpen}
        type="button"
      />
      <div className="pointer-events-none">
        <ItemIcon>
          <SparklesIcon aria-hidden className="size-6" />
        </ItemIcon>
      </div>
      <div className="pointer-events-none min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{skill.name}</p>
          <Badge className="shrink-0 font-normal" variant="secondary">
            v{skill.version}
          </Badge>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
        <p className="truncate text-xs text-muted-foreground">
          por {skill.author} · {categoryLabel(skill.category)}
        </p>
        <ToolChips tools={skill.tools} />
      </div>
      <InstallButton
        done={action.done}
        label={action.label}
        name={skill.name}
        onClick={onInstall}
        update={action.update}
      />
    </li>
  )
}

export type SkillsListViewProps = {
  skills: readonly CatalogSkillItem[] | null
  all: readonly CatalogSkillItem[]
  loading: boolean
  error: string | null
  category: string
  onCategory: (category: string) => void
  onOpen: (slug: string) => void
  onInstall: (slug: string) => void
  onRetry?: () => void
  /** O filtro de categoria mora no cabeçalho da página: a lista não o repete. */
  hideFilter?: boolean
}

/** Lista de skills do catálogo: filtro por categoria e um cartão por skill. */
export function SkillsListView({
  skills,
  all,
  loading,
  error,
  category,
  onCategory,
  onOpen,
  onInstall,
  onRetry,
  hideFilter,
}: SkillsListViewProps) {
  const items = skills ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Habilidades da comunidade</h3>
        {hideFilter ? null : (
          <CategorySelect
            categories={categoriesOf(all)}
            category={category}
            onCategory={onCategory}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Habilidades são instruções em texto. Instalar não libera nenhuma ferramenta nova.
      </p>
      <ListState
        empty={!loading && !error && items.length === 0}
        emptyText="Nenhuma habilidade encontrada."
        error={error}
        loading={loading}
        onRetry={onRetry}
      />
      {items.length > 0 ? (
        <ul className="flex flex-col divide-y md:grid md:grid-cols-2 md:gap-4 md:divide-y-0 xl:grid-cols-3">
          {items.map((skill) => (
            <SkillCard
              key={skill.slug}
              onInstall={() => onInstall(skill.slug)}
              onOpen={() => onOpen(skill.slug)}
              skill={skill}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function BotCard({
  bot,
  onOpen,
  onInstall,
}: {
  bot: CatalogBotEntry
  onOpen: () => void
  onInstall: () => void
}) {
  return (
    <li className="relative grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 py-4 md:grid-cols-[3rem_minmax(0,1fr)] md:grid-rows-[1fr_auto] md:rounded-2xl md:border md:bg-card/40 md:p-4 md:transition-colors md:hover:bg-muted/40">
      <button
        aria-label={`Ver detalhes de ${bot.name}`}
        className="absolute inset-0 md:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={onOpen}
        type="button"
      />
      <div className="pointer-events-none grid size-12 place-items-center">
        <AgentAvatar animated={false} bodyColor={resolveBotProposalColor(bot.color) ?? undefined} id={bot.slug} shape={bot.shape} size={44} />
      </div>
      <div className="pointer-events-none min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{bot.name}</p>
          <Badge className="shrink-0 font-normal" variant="secondary">
            v{bot.version}
          </Badge>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{bot.description}</p>
        <p className="truncate text-xs text-muted-foreground">
          por {bot.author} · {categoryLabel(bot.category)}
          {bot.skills.length > 0
            ? ` · ${bot.skills.length} ${bot.skills.length === 1 ? "habilidade" : "habilidades"}`
            : ""}
        </p>
      </div>
      <InstallButton label="Instalar" name={bot.name} onClick={onInstall} />
    </li>
  )
}

export type BotsListViewProps = {
  bots: readonly CatalogBotEntry[] | null
  all: readonly CatalogBotEntry[]
  loading: boolean
  error: string | null
  category: string
  onCategory: (category: string) => void
  onOpen: (slug: string) => void
  onInstall: (slug: string) => void
  onRetry?: () => void
  hideFilter?: boolean
}

/** Lista de agentes prontos do catálogo. */
export function BotsListView({
  bots,
  all,
  loading,
  error,
  category,
  onCategory,
  onOpen,
  onInstall,
  onRetry,
  hideFilter,
}: BotsListViewProps) {
  const items = bots ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Agentes prontos</h3>
        {hideFilter ? null : <CategorySelect categories={categoriesOf(all)} category={category} onCategory={onCategory} />}
      </div>
      <p className="text-xs text-muted-foreground">
        Cada agente nasce com as habilidades dele. Credenciais nunca vêm no modelo: você conecta as suas depois.
      </p>
      <ListState
        empty={!loading && !error && items.length === 0}
        emptyText="Nenhum agente encontrado."
        error={error}
        loading={loading}
        onRetry={onRetry}
      />
      {items.length > 0 ? (
        <ul className="flex flex-col divide-y md:grid md:grid-cols-2 md:gap-4 md:divide-y-0 xl:grid-cols-3">
          {items.map((bot) => (
            <BotCard
              bot={bot}
              key={bot.slug}
              onInstall={() => onInstall(bot.slug)}
              onOpen={() => onOpen(bot.slug)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function ChangelogList({ items }: { items: readonly CatalogChangelogEntry[] }) {
  return (
    <ol className="divide-y rounded-xl border bg-muted/20">
      {items.map((item) => (
        <li className="space-y-0.5 p-3" key={item.version}>
          <p className="text-sm font-medium">
            v{item.version}
            {item.date ? <span className="font-normal text-muted-foreground"> · {item.date}</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">{item.notes}</p>
        </li>
      ))}
    </ol>
  )
}

function FindingsAlert({ findings }: { findings: CatalogSkillDetail["findings"] }) {
  const blocked = findings.some((item) => item.severity === "block")
  if (findings.length === 0) return null
  return (
    <Alert variant={blocked ? "destructive" : "warning"}>
      <AlertTriangleIcon />
      <AlertTitle>{blocked ? "Conteúdo bloqueado" : "Revise antes de instalar"}</AlertTitle>
      <AlertDescription>
        {blocked
          ? "Este item tem instruções que o app não instala."
          : "Alguns trechos pedem atenção (por exemplo, comandos de rede). Leia o conteúdo abaixo."}
      </AlertDescription>
    </Alert>
  )
}

function BackButton({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null
  return (
    <Button className="-ml-2" onClick={onBack} size="sm" type="button" variant="ghost">
      <ArrowLeftIcon className="size-4" /> Voltar ao Marketplace
    </Button>
  )
}

export type SkillPageViewProps = {
  detail: CatalogSkillDetail | null
  loading: boolean
  error: string | null
  /** Sem `onBack` não mostra o botão (a página do Marketplace já tem o voltar no cabeçalho). */
  onBack?: () => void
  onInstall: () => void
}

/** Página da skill: instruções, ferramentas sugeridas, histórico e instalar/atualizar. */
export function SkillPageView({ detail, loading, error, onBack, onInstall }: SkillPageViewProps) {
  if (!detail) {
    return (
      <div className="min-w-0 space-y-6 pb-2">
        <BackButton onBack={onBack} />
        {loading ? <Skeleton className="h-40 rounded-xl" /> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    )
  }
  const { entry } = detail
  const summary = installSummary(detail.installs)
  const blocked = detail.findings.some((item) => item.severity === "block")
  const action = skillActionLabel(detail.installs)
  return (
    <div className="min-w-0 space-y-6 pb-2">
      <BackButton onBack={onBack} />
      <div className="flex flex-wrap items-center gap-4">
        <div className="[&>span]:size-16! [&>span]:rounded-2xl! [&_svg]:size-8!">
          <ItemIcon>
            <SparklesIcon aria-hidden />
          </ItemIcon>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{entry.name}</h2>
          <p className="text-xs text-muted-foreground">
            por {entry.author} · v{entry.version} · {categoryLabel(entry.category)}
          </p>
        </div>
        <Button
          disabled={blocked}
          onClick={onInstall}
          type="button"
          variant={action.done ? "secondary" : "default"}
        >
          {action.done ? <CheckIcon className="size-4" /> : null}
          {action.update ? "Atualizar" : action.done ? "Instalada · reinstalar" : "Instalar"}
        </Button>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{entry.description}</p>
      {summary.kind === "update" ? (
        <Alert>
          <RefreshCwIcon />
          <AlertTitle>Atualização disponível</AlertTitle>
          <AlertDescription>
            Você tem a v{summary.installed}; o catálogo está na v{entry.version}.
            {summary.edited ? " Você editou sua cópia: antes de sobrescrever eu mostro o que muda." : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      <FindingsAlert findings={detail.findings} />
      <Section title="Ferramentas que ela costuma usar">
        {detail.tools.length > 0 ? <ToolChips limit={20} tools={detail.tools} /> : (
          <p className="text-sm text-muted-foreground">Nenhuma sugestão de ferramenta.</p>
        )}
        <p className="text-xs text-muted-foreground">
          São apenas dicas. Instalar a habilidade não libera nenhuma ferramenta, conector ou segredo: o que o agente pode usar continua sendo decidido por você.
        </p>
      </Section>
      <Section title="Instruções">
        <div className="max-h-96 overflow-y-auto rounded-xl border bg-muted/20 p-4">
          <SkillMarkdownPreview markdown={detail.body} />
        </div>
      </Section>
      <Section title="Histórico de versões">
        <ChangelogList items={detail.changelog} />
      </Section>
      <Section title="Informações">
        <dl className="divide-y rounded-xl border bg-muted/20 px-4">
          <InfoRow label="Autor">{entry.author}</InfoRow>
          <InfoRow label="Categoria">{categoryLabel(entry.category)}</InfoRow>
          <InfoRow label="Versão">{entry.version}</InfoRow>
          <InfoRow label="Instalada">
            {detail.installs.length === 0
              ? "Ainda não"
              : `${detail.installs.length} ${detail.installs.length === 1 ? "lugar" : "lugares"}`}
          </InfoRow>
        </dl>
      </Section>
    </div>
  )
}

export type BotPageViewProps = {
  detail: CatalogBotDetail | null
  loading: boolean
  error: string | null
  onBack?: () => void
  onInstall: () => void
}

/** Página do agente: papel, skills que ele traz, conectores recomendados e rotinas sugeridas. */
export function BotPageView({ detail, loading, error, onBack, onInstall }: BotPageViewProps) {
  if (!detail) {
    return (
      <div className="min-w-0 space-y-6 pb-2">
        <BackButton onBack={onBack} />
        {loading ? <Skeleton className="h-40 rounded-xl" /> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    )
  }
  const { bot, entry } = detail
  const blocked = detail.findings.some((item) => item.severity === "block")
  return (
    <div className="min-w-0 space-y-6 pb-2">
      <BackButton onBack={onBack} />
      <div className="flex flex-wrap items-center gap-4">
        <AgentAvatar animated={false} bodyColor={bot.color} id={bot.slug} shape={bot.shape} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{bot.name}</h2>
          <p className="text-xs text-muted-foreground">
            por {entry.author} · v{entry.version} · {categoryLabel(entry.category)}
          </p>
        </div>
        <Button disabled={blocked} onClick={onInstall} type="button">
          Instalar
        </Button>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{bot.description}</p>
      <FindingsAlert findings={detail.findings} />
      {detail.skills.length > 0 ? (
        <Section title={`Habilidades que ele traz (${detail.skills.length})`}>
          <ul className="divide-y rounded-xl border bg-muted/20">
            {detail.skills.map((skill) => (
              <li className="space-y-1 p-3" key={skill.slug}>
                <p className="text-sm font-medium">
                  {skill.name} <span className="font-normal text-muted-foreground">· v{skill.version}</span>
                </p>
                <p className="text-xs text-muted-foreground">{skill.description}</p>
                <ToolChips tools={skill.tools} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail.connectors.length > 0 ? (
        <Section title="Conectores recomendados">
          <ul className="divide-y rounded-xl border bg-muted/20">
            {detail.connectors.map((connector) => (
              <li className="flex items-center justify-between gap-3 p-3" key={connector.id}>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{connector.id}</p>
                  {connector.reason ? <p className="text-xs text-muted-foreground">{connector.reason}</p> : null}
                </div>
                <Badge variant={connector.connected ? "default" : "outline"}>
                  {connectorStatusLabel(connector.connected)}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {bot.setupNotes.length > 0 ? (
        <Section title="Para começar">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {bot.setupNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {bot.starterRoutines.length > 0 ? (
        <Section title="Rotinas sugeridas">
          <p className="text-xs text-muted-foreground">Nada é criado sozinho: você marca as que quiser ao instalar.</p>
          <ul className="divide-y rounded-xl border bg-muted/20">
            {bot.starterRoutines.map((routine) => (
              <li className="space-y-0.5 p-3" key={routine.name}>
                <p className="text-sm font-medium">{routine.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{routine.cron}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Histórico de versões">
        <ChangelogList items={bot.changelog} />
      </Section>
    </div>
  )
}

