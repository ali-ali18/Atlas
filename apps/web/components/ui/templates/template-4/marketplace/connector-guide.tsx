"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { SparklesIcon } from "lucide-react"
import { CONNECTOR_GUIDE_MAX_CHARS, type ConnectorGuideView, type ConnectorKind } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert"
import { Textarea } from "@workspace/ui/components/textarea"
import { SkillMarkdownPreview } from "@/components/settings/sections/skills/skill-markdown-preview"
import {
  getConnectorGuide,
  regenerateConnectorGuide,
  resolveConnectorGuideSuggestion,
  saveConnectorGuide,
} from "@/lib/atlas-api"

/** Acima disso o guia aparece recortado, com "Ver tudo". */
export const GUIDE_PREVIEW_CHARS = 280
const POLL_MS = 3000
const POLL_MAX = 14

export function guideNeedsExpand(text: string): boolean {
  return text.length > GUIDE_PREVIEW_CHARS || text.split("\n").length > 5
}

function sourceLabel(guide: ConnectorGuideView): string {
  return guide.source === "user" ? "Editado por você" : "Gerado automaticamente"
}

export type ConnectorGuideViewProps = {
  guide: ConnectorGuideView | null
  editing?: boolean
  draft?: string
  expanded?: boolean
  busy?: boolean
  generating?: boolean
  confirmRegenerate?: boolean
  error?: string | null
  onEdit?: () => void
  onDraftChange?: (value: string) => void
  onSave?: () => void
  onCancelEdit?: () => void
  onToggleExpanded?: () => void
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
  expanded = false,
  busy = false,
  generating = false,
  confirmRegenerate = false,
  error = null,
  onEdit,
  onDraftChange,
  onSave,
  onCancelEdit,
  onToggleExpanded,
  onRegenerate,
  onConfirmRegenerate,
  onCancelRegenerate,
  onResolve,
}: ConnectorGuideViewProps) {
  const text = guide?.text ?? ""
  const hasText = text.trim().length > 0
  const long = guideNeedsExpand(text)
  const suggestions = guide?.suggestions ?? []
  return (
    <section aria-label="Guia de uso" className="min-w-0 space-y-2" data-slot="connector-guide">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Guia de uso</h3>
          {guide && hasText ? <p className="text-xs text-muted-foreground">{sourceLabel(guide)}</p> : null}
        </div>
        {!editing ? (
          <div className="-mr-3 flex items-center gap-1">
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
      </div>
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
          <div className={expanded || !long ? undefined : "max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"} data-expanded={expanded || !long}>
            <SkillMarkdownPreview markdown={text} />
          </div>
          {long ? (
            <Button className="-ml-3 mt-1 h-7 rounded-full px-3 text-xs" onClick={onToggleExpanded} size="sm" type="button" variant="ghost">
              {expanded ? "Ver menos" : "Ver tudo"}
            </Button>
          ) : null}
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
    </section>
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
  const [expanded, setExpanded] = useState(false)
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
      expanded={expanded}
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
      onToggleExpanded={() => setExpanded((value) => !value)}
    />
  )
}
