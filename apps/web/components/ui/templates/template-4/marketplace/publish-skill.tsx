"use client"

import { useEffect, useState } from "react"
import { scanSuspiciousInstructions } from "@workspace/shared"
import { publishSkill, type PublishSkillForm, type PublishSkillResult, type SkillDocView } from "@/lib/atlas-api"
import { createZip } from "@/lib/zip"
import { useTranslations } from "@/lib/i18n/provider"
import { CatalogPanel, PublishFlow } from "./catalog-panels"
import { suggestVersion } from "./catalog-state"

const AUTHOR_KEY = "atlas.publish.author"

function rememberedAuthor(): string {
  try {
    return window.localStorage.getItem(AUTHOR_KEY) ?? ""
  } catch {
    return ""
  }
}

function saveAuthor(author: string) {
  try {
    window.localStorage.setItem(AUTHOR_KEY, author)
  } catch {
    // Sem storage: só não lembra o autor.
  }
}

export function downloadZip(fileName: string, files: Array<{ path: string; content: string }>) {
  const bytes = createZip(files)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * "Publicar no marketplace" de uma skill do usuário (ou cópia editada de uma instalada):
 * abre um PR no catálogo com a conexão do GitHub dele; sem permissão, oferece o pacote.
 */
export function PublishSkillPanel({
  skill,
  loadFull,
  onClose,
}: {
  skill: SkillDocView | null
  loadFull: (id: string) => Promise<SkillDocView>
  onClose: () => void
}) {
  const { t } = useTranslations()
  const [full, setFull] = useState<SkillDocView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublishSkillResult | null>(null)
  const id = skill?.id

  useEffect(() => {
    setFull(null)
    setResult(null)
    setError(null)
    if (!id) return
    let cancelled = false
    loadFull(id).then(
      (loaded) => {
        if (!cancelled) setFull(loaded)
      },
      () => {
        if (!cancelled) setError(t("marketplace.publishSkill.openError"))
      }
    )
    return () => {
      cancelled = true
    }
  }, [id, loadFull])

  const findings = full ? scanSuspiciousInstructions([full.name, full.description, full.body ?? ""].join("\n")) : []
  const baseVersion = skill?.source?.version ?? null
  const defaults: PublishSkillForm = {
    version: suggestVersion(baseVersion),
    category: "geral",
    tags: [],
    notes: "",
    author: typeof window === "undefined" ? "" : rememberedAuthor(),
  }

  async function submit(form: PublishSkillForm) {
    if (!skill) return
    setBusy(true)
    setError(null)
    try {
      saveAuthor(form.author)
      setResult(await publishSkill(skill.id, form))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("marketplace.publishSkill.failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CatalogPanel
      description={t("marketplace.publishSkill.description")}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={skill !== null}
      title={t("marketplace.publishSkill.title")}
    >
      {skill && full ? (
        <PublishFlow
          baseVersion={baseVersion}
          busy={busy}
          defaults={defaults}
          error={error}
          findings={findings}
          key={skill.id}
          name={skill.name}
          onClose={onClose}
          onDownload={(files, slug) => downloadZip(`${slug}.zip`, files)}
          onSubmit={(form) => void submit(form)}
          result={result}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground" role={error ? "alert" : undefined}>
          {error ?? t("common.loading")}
        </p>
      )}
    </CatalogPanel>
  )
}
