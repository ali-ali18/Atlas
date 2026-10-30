"use client"

import type { ApiGroup } from "@workspace/shared"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslations } from "@/lib/i18n/provider"

/**
 * Grupos (tags) da API com o acesso liberado ao agente. Etapa de leitura: só
 * os grupos com operações de leitura podem ser ligados (padrão: todos); a
 * escrita não aparece (só o aviso de que chega em breve).
 */
export function ApiGroupsPicker({
  groups,
  selected,
  onChange,
  disabled = false,
  className,
}: {
  groups: readonly ApiGroup[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  className?: string
}) {
  const { t, tn } = useTranslations()
  const readable = groups.filter((group) => group.read > 0)
  const toggle = (tag: string, on: boolean) =>
    onChange(on ? [...selected, tag] : selected.filter((item) => item !== tag))
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <ul className="m-0 flex list-none flex-col p-0" aria-label={t("aiElements.apiGroups.allowed")}>
        {readable.map((group) => {
          const id = `api-group-${group.tag}`
          return (
            <li
              className="grid min-h-9 grid-cols-[1fr_auto] items-center gap-3 py-1"
              key={group.tag}
            >
              <label className="min-w-0" htmlFor={id}>
                <span className="block truncate text-sm">{group.tag}</span>
                <span className="block text-xs text-muted-foreground">
                  {tn("aiElements.apiGroups.queries", group.read)}
                </span>
              </label>
              <Switch
                aria-label={t("aiElements.apiGroups.allow", { group: group.tag })}
                checked={selected.includes(group.tag)}
                disabled={disabled}
                id={id}
                onCheckedChange={(on) => toggle(group.tag, on)}
                size="sm"
              />
            </li>
          )
        })}
      </ul>
      <p className="m-0 text-xs text-muted-foreground">
        {t("aiElements.apiGroups.writeSoon")}
      </p>
    </div>
  )
}
