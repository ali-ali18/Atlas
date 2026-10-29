"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDownIcon, PencilIcon, RefreshCwIcon, SparklesIcon } from "lucide-react"
import { CONNECTOR_GUIDE_MAX_CHARS, GUIDE_GENERATING_STALE_MS, type ConnectorGuideView, type ConnectorKind } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert"
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip"
import { Textarea } from "@workspace/ui/components/textarea"
import { SkillMarkdownPreview } from "@/components/settings/sections/skills/skill-markdown-preview"
import {
  getConnectorGuide,
  regenerateConnectorGuide,
  resolveConnectorGuideSuggestion,
  saveConnectorGuide,
} from "@/lib/atlas-api"
import { useTranslations } from "@/lib/i18n/provider"
import type { TFunction } from "@/lib/i18n/translator"

const POLL_MS = 3000
/** Primeiros ~3 min a cada 3 s; depois a cada 15 s enquanto o painel estiver aberto. */
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 15_000

function sourceLabel(guide: ConnectorGuideView, t: TFunction): string {
  return guide.source === "user" ? t("marketplace.guide.sourceUser") : t("marketplace.guide.sourceAuto")
}

function IconAction({ icon: Icon, label, onClick, disabled, spinning = false }: { icon: typeof PencilIcon; label: string; onClick?: () => void; disabled?: boolean; spinning?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={label} disabled={disabled} onClick={onClick} size="icon-sm" type="button" variant="ghost">
            <Icon aria-hidden className={spinning ? "size-4 motion-safe:animate-spin" : "size-4"} />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export type ConnectorGuideViewProps = {
  guide: ConnectorGuideView | null
  editing?: boolean
  draft?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  busy?: boolean
  generating?: boolean
  confirmRegenerate?: boolean
  error?: string | null
  onEdit?: () => void
  onDraftChange?: (value: string) => void
  onSave?: () => void
  onCancelEdit?: () => void
  onRegenerate?: () => void
  onConfirmRegenerate?: () => void
  onCancelRegenerate?: () => void
  onResolve?: (id: string, action: "accept" | "dismiss") => void
}

/** Bloco "Guia de uso": apresentação pura (o estado mora em `ConnectorGuide`). */
export function ConnectorGuideBlock({
  guide,
  editing = false,
  draft = "",
  open = false,
  onOpenChange,
  busy = false,
  generating = false,
  confirmRegenerate = false,
  error = null,
  onEdit,
  onDraftChange,
  onSave,
  onCancelEdit,
  onRegenerate,
  onConfirmRegenerate,
  onCancelRegenerate,
  onResolve,
}: ConnectorGuideViewProps) {
  const { t, tn } = useTranslations()
  const text = guide?.text ?? ""
  const isGenerating = generating || guide?.status === "generating"
  const failure = !isGenerating && guide?.status === "failed" ? guide.error || t("marketplace.guide.failed") : null
  const shownError = error ?? failure
  const hasText = text.trim().length > 0
  const suggestions = guide?.suggestions ?? []
  return (
    <Collapsible className="min-w-0" onOpenChange={onOpenChange} open={open}>
    <section aria-label={t("marketplace.guide.title")} className="min-w-0 space-y-2" data-slot="connector-guide">
      <CollapsibleTrigger className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{t("marketplace.guide.title")}</span>
          {guide && hasText ? <span className="block text-xs text-muted-foreground">{sourceLabel(guide, t)}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {isGenerating ? <span className="text-xs text-muted-foreground">{t("marketplace.guide.generating")}</span> : null}
          {suggestions.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {tn("marketplace.guide.suggestions", suggestions.length)}
            </span>
          ) : null}
          <ChevronDownIcon aria-hidden className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2">
      {!editing ? (
        <div className="flex items-center justify-end gap-1">
          {hasText ? <IconAction disabled={busy || isGenerating} icon={PencilIcon} label={t("marketplace.guide.edit")} onClick={onEdit} /> : null}
          <IconAction
            disabled={busy || isGenerating}
            icon={RefreshCwIcon}
            label={hasText ? t("marketplace.guide.regenerate") : t("marketplace.guide.generate")}
            onClick={onRegenerate}
            spinning={isGenerating}
          />
        </div>
      ) : null}
      {shownError ? (
        <p className="m-0 text-xs text-destructive" role="alert">
          {shownError}
        </p>
      ) : null}
      {confirmRegenerate ? (
        <ConfirmAlert
          cancelLabel={t("marketplace.guide.keepMine")}
          confirmLabel={t("marketplace.guide.regenerate")}
          description={t("marketplace.guide.replaceDescription")}
          disabled={busy}
          onCancel={onCancelRegenerate ?? (() => undefined)}
          onConfirm={onConfirmRegenerate ?? (() => undefined)}
          title={t("marketplace.guide.replaceTitle")}
        />
      ) : null}
      {editing ? (
        <div className="space-y-2">
          <Textarea
            aria-label={t("marketplace.guide.textLabel")}
            className="min-h-40 rounded-xl text-sm"
            maxLength={CONNECTOR_GUIDE_MAX_CHARS}
            onChange={(event) => onDraftChange?.(event.target.value)}
            value={draft}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("marketplace.guide.chars", { count: draft.length, max: CONNECTOR_GUIDE_MAX_CHARS })}
            </span>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={onCancelEdit} size="sm" type="button" variant="ghost">
                {t("common.cancel")}
              </Button>
              <Button disabled={busy || !draft.trim()} onClick={onSave} size="sm" type="button">
                {busy ? t("marketplace.guide.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      ) : hasText ? (
        <div className="rounded-xl border bg-muted/20 px-4 py-3">
          {isGenerating ? <p className="m-0 mb-2 text-xs text-muted-foreground">{t("marketplace.guide.generating")}</p> : null}
          <SkillMarkdownPreview markdown={text} />
        </div>
      ) : (
        <p className="m-0 rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {isGenerating ? t("marketplace.guide.generating") : t("marketplace.guide.empty")}
        </p>
      )}
      {suggestions.map((suggestion) => (
        <div className="space-y-2 rounded-xl border bg-muted/20 px-4 py-3" data-slot="guide-suggestion" key={suggestion.id}>
          <p className="m-0 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <SparklesIcon aria-hidden className="size-3.5" />
            {t("marketplace.guide.botSuggestion")}
          </p>
          <p className="m-0 break-words text-sm">{suggestion.text}</p>
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => onResolve?.(suggestion.id, "dismiss")} size="sm" type="button" variant="ghost">
              {t("marketplace.guide.dismiss")}
            </Button>
            <Button disabled={busy} onClick={() => onResolve?.(suggestion.id, "accept")} size="sm" type="button" variant="secondary">
              {t("marketplace.guide.accept")}
            </Button>
          </div>
        </div>
      ))}
      <p className="m-0 text-xs text-muted-foreground">{t("marketplace.guide.note")}</p>
      </CollapsibleContent>
    </section>
    </Collapsible>
  )
}

/** Guia de uma conexão com edição, nova geração (com confirmação se foi editado) e sugestões. */
export function ConnectorGuide({
  kind,
  connectionId,
  guide: initial,
}: {
  kind: ConnectorKind
  connectionId: string
  guide: ConnectorGuideView | null | undefined
}) {
  const { t } = useTranslations()
  const [guide, setGuide] = useState<ConnectorGuideView | null>(initial ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(initial?.status === "generating")
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastUpdated = useRef(initial?.updatedAt ?? null)

  useEffect(() => {
    setGuide(initial ?? null)
    setEditing(false)
    setGenerating(initial?.status === "generating")
    setConfirming(false)
    lastUpdated.current = initial?.updatedAt ?? null
    // Só ao trocar de conexão: edições locais não são sobrescritas por re-render do pai.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  // O worker grava em segundo plano (e registra falhas na conexão): consulta até sair de "gerando".
  useEffect(() => {
    if (!generating) return
    // Depois da janela rápida só consulta com o painel aberto; reabrir reinicia o ciclo lento.
    const startedAt = Date.now()
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const elapsed = Date.now() - startedAt
      const fast = elapsed < FAST_POLL_WINDOW_MS
      if (fast || open) {
        try {
          const next = await getConnectorGuide(kind, connectionId)
          if (!alive) return
          const finished = next ? next.status !== "generating" && (next.status === "failed" || next.updatedAt !== lastUpdated.current) : false
          if (next && finished) {
            lastUpdated.current = next.updatedAt
            setGuide(next)
            setGenerating(false)
            return
          }
          if (elapsed > GUIDE_GENERATING_STALE_MS + POLL_MS) {
            setGenerating(false)
            setError(t("marketplace.guide.stale"))
            return
          }
        } catch {
          /* tenta de novo no próximo ciclo */
        }
      }
      if (alive) timer = setTimeout(() => void tick(), fast ? POLL_MS : SLOW_POLL_MS)
    }
    timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [generating, open, kind, connectionId, t])

  const run = useCallback(async (task: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : fallback)
    } finally {
      setBusy(false)
    }
  }, [])

  const regenerate = (confirm: boolean) =>
    run(async () => {
      await regenerateConnectorGuide(kind, connectionId, confirm)
      setConfirming(false)
      setGenerating(true)
    }, t("marketplace.guide.generateError"))

  return (
    <ConnectorGuideBlock
      busy={busy}
      confirmRegenerate={confirming}
      draft={draft}
      editing={editing}
      error={error}
      onOpenChange={setOpen}
      open={open}
      generating={generating}
      guide={guide}
      onCancelEdit={() => setEditing(false)}
      onCancelRegenerate={() => setConfirming(false)}
      onConfirmRegenerate={() => void regenerate(true)}
      onDraftChange={setDraft}
      onEdit={() => {
        setDraft(guide?.text ?? "")
        setEditing(true)
        setError(null)
      }}
      onRegenerate={() => (guide?.source === "user" && guide.text.trim() ? setConfirming(true) : void regenerate(false))}
      onResolve={(id, action) =>
        void run(async () => {
          const next = await resolveConnectorGuideSuggestion(kind, connectionId, id, action)
          setGuide(next)
          if (next) lastUpdated.current = next.updatedAt
        }, t("marketplace.guide.updateSuggestionError"))
      }
      onSave={() =>
        void run(async () => {
          const next = await saveConnectorGuide(kind, connectionId, draft.trim())
          setGuide(next)
          lastUpdated.current = next.updatedAt
          setEditing(false)
        }, t("marketplace.guide.saveError"))
      }
    />
  )
}
