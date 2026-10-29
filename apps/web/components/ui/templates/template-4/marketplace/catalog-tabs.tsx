"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  AtlasApiError,
  catalogEditedConflict,
  createRoutine,
  getCatalog,
  getCatalogBot,
  getCatalogSkill,
  installCatalogBot,
  installCatalogSkill,
  listBots,
  type CatalogBotDetail,
  type CatalogEditedConflict,
  type CatalogInstallView,
  type CatalogListResponse,
  type CatalogSkillDetail,
} from "@/lib/atlas-api"
import {
  BotInstallFlow,
  CatalogPanel,
  SkillConflictFlow,
  SkillInstallFlow,
} from "./catalog-panels"
import {
  BotPageView,
  BotsListView,
  SkillPageView,
  SkillsListView,
} from "./catalog-views"
import { filterCatalogItems } from "./catalog-state"
import { useTranslations } from "@/lib/i18n/provider"

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/** Lista do catálogo (skills e agentes), carregada quando o Marketplace abre. */
export function useCatalogData(open: boolean) {
  const { t } = useTranslations()
  const [data, setData] = useState<CatalogListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    getCatalog().then(
      (result) => {
        if (cancelled) return
        setData(result)
        setError(null)
        setLoading(false)
      },
      (cause) => {
        if (cancelled) return
        setError(errorText(cause, t("marketplace.catalog.loadError")))
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  return { data, error, loading: loading && !data, reload }
}

type DoneState = { title: string; text: string; openBotId?: string; warnings?: string[] }

function DoneFlow({ done, onClose, onOpenBot }: { done: DoneState; onClose: () => void; onOpenBot?: (botId: string) => void }) {
  const { t } = useTranslations()
  return (
    <>
      <div className="px-4 pt-4">
        <h2 className="text-base font-semibold">{done.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{done.text}</p>
        {done.warnings && done.warnings.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {done.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-2 px-4 pt-5 sm:flex-row sm:justify-end">
        <Button onClick={onClose} type="button" variant={done.openBotId ? "outline" : "default"}>
          {t("marketplace.catalog.done")}
        </Button>
        {done.openBotId && onOpenBot ? (
          <Button onClick={() => onOpenBot(done.openBotId as string)} type="button">
            {t("marketplace.catalog.openChat")}
          </Button>
        ) : null}
      </div>
    </>
  )
}

function LoadingFlow() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-24" />
    </div>
  )
}

type SkillInstallState =
  | { stage: "loading"; slug: string }
  | {
      stage: "pick"
      slug: string
      detail: CatalogSkillDetail
      bots: Array<{ id: string; name: string }>
      busy: boolean
      error: string | null
    }
  | {
      stage: "conflict"
      slug: string
      name: string
      botId: string | null
      conflict: CatalogEditedConflict
      busy: boolean
      error: string | null
    }
  | { stage: "done"; slug: string; done: DoneState }

/** Fluxo de instalar/atualizar uma skill: escolher escopo, resolver cópia editada, confirmar. */
export function useSkillInstaller(onChanged: () => void) {
  const { t } = useTranslations()
  const [state, setState] = useState<SkillInstallState | null>(null)

  async function start(slug: string) {
    setState({ stage: "loading", slug })
    try {
      const [detail, bots] = await Promise.all([getCatalogSkill(slug), listBots()])
      setState({
        stage: "pick",
        slug,
        detail,
        bots: bots.filter((bot) => !bot.memberIds?.length).map((bot) => ({ id: bot.id, name: bot.name })),
        busy: false,
        error: null,
      })
    } catch (cause) {
      setState({ stage: "done", slug, done: { title: t("marketplace.catalog.cantOpen"), text: errorText(cause, t("marketplace.catalog.tryAgainSoon")) } })
    }
  }

  async function run(botId: string | null, mode?: "update" | "keep") {
    setState((current) => (current && (current.stage === "pick" || current.stage === "conflict") ? { ...current, busy: true, error: null } : current))
    const slug = state?.slug ?? ""
    const name = state && state.stage === "pick" ? state.detail.entry.name : state && state.stage === "conflict" ? state.name : slug
    try {
      const result = await installCatalogSkill(slug, { botId, ...(mode ? { mode } : {}) })
      const text =
        result.action === "kept"
          ? t("marketplace.skillInstall.kept")
          : result.action === "unchanged"
            ? t("marketplace.skillInstall.unchanged")
            : result.action === "updated"
              ? t("marketplace.skillInstall.updated")
              : t("marketplace.skillInstall.installedText")
      setState({ stage: "done", slug, done: { title: result.action === "installed" ? t("marketplace.skillInstall.installedTitle") : t("marketplace.skillInstall.allGood"), text } })
      onChanged()
    } catch (cause) {
      const conflict = catalogEditedConflict(cause)
      if (conflict) {
        setState({ stage: "conflict", slug, name, botId, conflict, busy: false, error: null })
        return
      }
      const message = errorText(cause, t("marketplace.skillInstall.failed"))
      setState((current) => (current && (current.stage === "pick" || current.stage === "conflict") ? { ...current, busy: false, error: message } : current))
    }
  }

  const close = () => setState(null)

  const panel = (
    <CatalogPanel
      description={t("marketplace.skillInstall.panelDescription")}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      open={state !== null}
      title={t("marketplace.skillInstall.panelTitle")}
    >
      {state?.stage === "loading" ? <LoadingFlow /> : null}
      {state?.stage === "pick" ? (
        <SkillInstallFlow
          bots={state.bots}
          busy={state.busy}
          error={state.error}
          installs={state.detail.installs}
          name={state.detail.entry.name}
          onClose={close}
          onInstall={(botId) => void run(botId)}
          tools={state.detail.tools}
          version={state.detail.entry.version}
        />
      ) : null}
      {state?.stage === "conflict" ? (
        <SkillConflictFlow
          busy={state.busy}
          catalogVersion={state.conflict.catalogVersion}
          diff={state.conflict.diff}
          error={state.error}
          installedVersion={state.conflict.installedVersion}
          name={state.name}
          onChoose={(mode) => void run(state.botId, mode)}
          onClose={close}
        />
      ) : null}
      {state?.stage === "done" ? <DoneFlow done={state.done} onClose={close} /> : null}
    </CatalogPanel>
  )
  return { start, panel }
}

type BotInstallState =
  | { stage: "loading"; slug: string }
  | { stage: "form"; slug: string; detail: CatalogBotDetail; busy: boolean; error: string | null }
  | { stage: "done"; slug: string; done: DoneState }

/** Fluxo de instalar um agente do catálogo (cria o bot, as skills e só as rotinas marcadas). */
export function useBotInstaller(onChanged: () => void, onInstalled?: (botId: string) => void, onOpenBot?: (botId: string) => void) {
  const { t, tn } = useTranslations()
  const [state, setState] = useState<BotInstallState | null>(null)

  async function start(slug: string) {
    setState({ stage: "loading", slug })
    try {
      setState({ stage: "form", slug, detail: await getCatalogBot(slug), busy: false, error: null })
    } catch (cause) {
      setState({ stage: "done", slug, done: { title: t("marketplace.catalog.cantOpen"), text: errorText(cause, t("marketplace.catalog.tryAgainSoon")) } })
    }
  }

  async function install(input: Parameters<typeof installCatalogBot>[1]) {
    if (state?.stage !== "form") return
    const { slug } = state
    setState({ ...state, busy: true, error: null })
    try {
      const result = await installCatalogBot(slug, input)
      const warnings = [...(result.warnings ?? [])]
      let created = 0
      for (const routine of result.routines) {
        try {
          await createRoutine(result.botId, { name: routine.name, prompt: routine.prompt, schedule: routine.cron, enabled: true })
          created += 1
        } catch {
          warnings.push(t("marketplace.botInstall.routineFailed", { name: routine.name }))
        }
      }
      onInstalled?.(result.botId)
      onChanged()
      const skills = result.installedSkills.length
      const createdText = (name: string, skillCount: number, routineCount: number) => {
        const skillsText = tn("marketplace.botInstall.skillCount", skillCount)
        const routinesText = tn("marketplace.botInstall.routineCount", routineCount)
        if (skillCount && routineCount) return t("marketplace.botInstall.createdWithBoth", { name, skills: skillsText, routines: routinesText })
        if (skillCount) return t("marketplace.botInstall.createdWithSkills", { name, skills: skillsText })
        if (routineCount) return t("marketplace.botInstall.createdWithRoutines", { name, routines: routinesText })
        return t("marketplace.botInstall.createdText", { name })
      }
      setState({
        stage: "done",
        slug,
        done: {
          title: t("marketplace.botInstall.createdTitle"),
          text: createdText(result.name, skills, created),
          openBotId: result.botId,
          warnings,
        },
      })
    } catch (cause) {
      const message = cause instanceof AtlasApiError && cause.status === 422 ? t("marketplace.botInstall.blocked") : errorText(cause, t("marketplace.botInstall.failed"))
      setState((current) => (current?.stage === "form" ? { ...current, busy: false, error: message } : current))
    }
  }

  const close = () => setState(null)

  const panel = (
    <CatalogPanel
      description={t("marketplace.botInstall.panelDescription")}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      open={state !== null}
      title={t("marketplace.botInstall.panelTitle")}
    >
      {state?.stage === "loading" ? <LoadingFlow /> : null}
      {state?.stage === "form" ? (
        <BotInstallFlow busy={state.busy} detail={state.detail} error={state.error} onClose={close} onInstall={(input) => void install(input)} />
      ) : null}
      {state?.stage === "done" ? (
        <DoneFlow
          done={state.done}
          onClose={close}
          onOpenBot={
            onOpenBot
              ? (botId) => {
                  close()
                  onOpenBot(botId)
                }
              : undefined
          }
        />
      ) : null}
    </CatalogPanel>
  )
  return { start, panel }
}

export type CatalogTabProps = {
  data: CatalogListResponse | null
  loading: boolean
  error: string | null
  query: string
  category: string
  onCategory: (category: string) => void
  onOpen: (slug: string) => void
  onReload: () => void
  onBotInstalled?: (botId: string) => void
  onOpenBot?: (botId: string) => void
}

export function CatalogSkillsTab({ data, loading, error, query, category, onCategory, onOpen, onReload }: CatalogTabProps) {
  const installer = useSkillInstaller(onReload)
  const all = data?.skills ?? []
  const shown = useMemo(() => filterCatalogItems(all, query, category), [all, query, category])
  return (
    <>
      <SkillsListView
        all={all}
        category={category}
        hideFilter
        error={error}
        loading={loading}
        onCategory={onCategory}
        onInstall={(slug) => void installer.start(slug)}
        onOpen={onOpen}
        onRetry={onReload}
        skills={data ? shown : null}
      />
      {installer.panel}
    </>
  )
}

export function CatalogBotsTab({ data, loading, error, query, category, onCategory, onOpen, onReload, onBotInstalled, onOpenBot }: CatalogTabProps) {
  const installer = useBotInstaller(onReload, onBotInstalled, onOpenBot)
  const all = data?.bots ?? []
  const shown = useMemo(() => filterCatalogItems(all, query, category), [all, query, category])
  return (
    <>
      <BotsListView
        all={all}
        bots={data ? shown : null}
        category={category}
        hideFilter
        error={error}
        loading={loading}
        onCategory={onCategory}
        onInstall={(slug) => void installer.start(slug)}
        onOpen={onOpen}
        onRetry={onReload}
      />
      {installer.panel}
    </>
  )
}

export function CatalogSkillPage({ slug, onBack, onChanged }: { slug: string; onBack?: () => void; onChanged: () => void }) {
  const { t } = useTranslations()
  const [detail, setDetail] = useState<CatalogSkillDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const installer = useSkillInstaller(() => {
    setVersion((value) => value + 1)
    onChanged()
  })

  useEffect(() => {
    let cancelled = false
    getCatalogSkill(slug).then(
      (result) => {
        if (!cancelled) setDetail(result)
      },
      (cause) => {
        if (!cancelled) setError(errorText(cause, t("marketplace.catalog.openSkillError")))
      }
    )
    return () => {
      cancelled = true
    }
  }, [slug, version])

  return (
    <>
      <SkillPageView detail={detail} error={error} loading={!detail && !error} onBack={onBack} onInstall={() => void installer.start(slug)} />
      {installer.panel}
    </>
  )
}

export function CatalogBotPage({
  slug,
  onBack,
  onChanged,
  onBotInstalled,
  onOpenBot,
}: {
  slug: string
  onBack?: () => void
  onChanged: () => void
  onBotInstalled?: (botId: string) => void
  onOpenBot?: (botId: string) => void
}) {
  const { t } = useTranslations()
  const [detail, setDetail] = useState<CatalogBotDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const installer = useBotInstaller(onChanged, onBotInstalled, onOpenBot)

  useEffect(() => {
    let cancelled = false
    getCatalogBot(slug).then(
      (result) => {
        if (!cancelled) setDetail(result)
      },
      (cause) => {
        if (!cancelled) setError(errorText(cause, t("marketplace.catalog.openAgentError")))
      }
    )
    return () => {
      cancelled = true
    }
  }, [slug])

  return (
    <>
      <BotPageView detail={detail} error={error} loading={!detail && !error} onBack={onBack} onInstall={() => void installer.start(slug)} />
      {installer.panel}
    </>
  )
}

export type { CatalogInstallView }
