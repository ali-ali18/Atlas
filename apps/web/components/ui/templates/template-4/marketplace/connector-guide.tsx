"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDownIcon, SparklesIcon } from "lucide-react"
import { CONNECTOR_GUIDE_MAX_CHARS, type ConnectorGuideView, type ConnectorKind } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert"
import { Textarea } from "@workspace/ui/components/textarea"
import { SkillMarkdownPreview } from "@/components/settings/sections/skills/skill-markdown-preview"
import {
  getConnectorGuide,
  regenerateConnectorGuide,
  resolveConnectorGuideSuggestion,
  saveConnectorGuide,
} from "@/lib/atlas-api"

const POLL_MS = 3000
const POLL_MAX = 14

function sourceLabel(guide: ConnectorGuideView): string {
  return guide.source === "user" ? "Editado por você" : "Gerado automaticamente"
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
  const text = guide?.text ?? ""
  const hasText = text.trim().length > 0
  const suggestions = guide?.suggestions ?? []
  return (
    <Collapsible className="min-w-0" onOpenChange={onOpenChange} open={open}>
    <section aria-label="Guia de uso" className="min-w-0 space-y-2" data-slot="connector-guide">
      <CollapsibleTrigger className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Guia de uso</span>
          {guide && hasText ? <span className="block text-xs text-muted-foreground">{sourceLabel(guide)}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {suggestions.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {suggestions.length} {suggestions.length === 1 ? "sugestão" : "sugestões"}
            </span>
          ) : null}
          <ChevronDownIcon aria-hidden className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2">
      {!editing ? (
        <div className="-mr-3 flex items-center justify-end gap-1">
          {hasText ? (
            <Button className="h-7 rounded-full px-3 text-xs" disabled={busy || generating} onClick={onEdit} size="sm" type="button" variant="ghost">
              Editar
            </Button>
          ) : null}
          <Button className="h-7 rounded-full px-3 text-xs" disabled={busy || generating} onClick={onRegenerate} size="sm" type="button" variant="ghost">
            {generating ? "Gerando…" : hasText ? "Gerar de novo" : "Gerar guia"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {confirmRegenerate ? (
        <ConfirmAlert
          cancelLabel="Manter meu texto"
          confirmLabel="Gerar de novo"
          description="O guia foi editado por você. Gerar de novo substitui o texto atual."
          disabled={busy}
          onCancel={onCancelRegenerate ?? (() => undefined)}
          onConfirm={onConfirmRegenerate ?? (() => undefined)}
          title="Substituir o guia editado?"
        />
      ) : null}
      {editing ? (
        <div className="space-y-2">
          <Textarea
            aria-label="Texto do guia"
            className="min-h-40 rounded-xl text-sm"
            maxLength={CONNECTOR_GUIDE_MAX_CHARS}
            onChange={(event) => onDraftChange?.(event.target.value)}
            value={draft}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {draft.length} de {CONNECTOR_GUIDE_MAX_CHARS} caracteres
            </span>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={onCancelEdit} size="sm" type="button" variant="ghost">
                Cancelar
              </Button>
              <Button disabled={busy || !draft.trim()} onClick={onSave} size="sm" type="button">
                {busy ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </div>
        </div>
      ) : hasText ? (
        <div className="rounded-xl border bg-muted/20 px-4 py-3">
          <SkillMarkdownPreview markdown={text} />
        </div>
      ) : (
        <p className="m-0 rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {generating ? "Gerando o guia a partir das ferramentas do conector…" : "O guia ainda não foi gerado. Ele diz ao bot como usar as ferramentas deste conector (qual id passar, formatos, filtros)."}
        </p>
      )}
      {suggestions.map((suggestion) => (
        <div className="space-y-2 rounded-xl border bg-muted/20 px-4 py-3" data-slot="guide-suggestion" key={suggestion.id}>
          <p className="m-0 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <SparklesIcon aria-hidden className="size-3.5" />
            Sugestão do bot
          </p>
          <p className="m-0 break-words text-sm">{suggestion.text}</p>
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => onResolve?.(suggestion.id, "dismiss")} size="sm" type="button" variant="ghost">
              Descartar
            </Button>
            <Button disabled={busy} onClick={() => onResolve?.(suggestion.id, "accept")} size="sm" type="button" variant="secondary">
              Aceitar
            </Button>
          </div>
        </div>
      ))}
      <p className="m-0 text-xs text-muted-foreground">O bot lê este guia como dado de apoio; ele não muda as regras nem o que você pede.</p>
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
  const [guide, setGuide] = useState<ConnectorGuideView | null>(initial ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastUpdated = useRef(initial?.updatedAt ?? null)

  useEffect(() => {
    setGuide(initial ?? null)
    setEditing(false)
    setGenerating(false)
    setConfirming(false)
    lastUpdated.current = initial?.updatedAt ?? null
    // Só ao trocar de conexão: edições locais não são sobrescritas por re-render do pai.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  // Depois de "Gerar de novo" o worker grava em segundo plano: consulta até o guia mudar.
  useEffect(() => {
    if (!generating) return
    let alive = true
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      try {
        const next = await getConnectorGuide(kind, connectionId)
        if (!alive) return
        if (next && next.updatedAt !== lastUpdated.current) {
          lastUpdated.current = next.updatedAt
          setGuide(next)
          setGenerating(false)
          return
        }
      } catch {
        /* tenta de novo no próximo ciclo */
      }
      if (alive && attempts >= POLL_MAX) {
        setGenerating(false)
        setError("A geração está demorando. Atualize a página em instantes.")
      }
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [generating, kind, connectionId])

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
    }, "Não foi possível gerar o guia.")

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
        }, "Não foi possível atualizar a sugestão.")
      }
      onSave={() =>
        void run(async () => {
          const next = await saveConnectorGuide(kind, connectionId, draft.trim())
          setGuide(next)
          lastUpdated.current = next.updatedAt
          setEditing(false)
        }, "Não foi possível salvar o guia.")
      }
    />
  )
}
