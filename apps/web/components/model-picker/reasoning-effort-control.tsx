"use client"
import type { ReasoningEffort } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { ButtonGroup } from "@workspace/ui/components/button-group"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslations } from "@/lib/i18n/provider"
import { reasoningEffortLabel } from "@/lib/reasoning-effort"

/**
 * "Raciocínio: Padrão do modelo · Desligado · Baixo · Médio · Alto". Só recebe os níveis que o modelo aceita
 * (`reasoningChoicesFor`); "Padrão do modelo" é sempre a opção neutra (não manda nada ao provedor).
 */
export function ReasoningEffortControl({
  choices,
  value,
  onChange,
  className,
}: {
  choices: readonly ReasoningEffort[]
  /** O que a tela mostra como selecionado (`shownReasoningEffort`); `undefined` = Padrão do modelo. */
  value: ReasoningEffort | undefined
  onChange: (effort: ReasoningEffort | undefined) => void
  className?: string
}) {
  const translator = useTranslations()
  const { t } = translator
  const options: Array<{ key: string; effort: ReasoningEffort | undefined; label: string; title?: string }> = [
    { key: "default", effort: undefined, label: t("reasoning.defaultShort"), title: t("reasoning.default") },
    ...choices.map((effort) => ({ key: effort, effort, label: reasoningEffortLabel(effort, translator) })),
  ]
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-reasoning-effort="">
      <span className="text-body font-medium" id="reasoning-effort-label">
        {t("reasoning.label")}
      </span>
      <ButtonGroup aria-labelledby="reasoning-effort-label" className="w-full">
        {options.map((option) => {
          const selected = option.effort === value
          return (
            <Button
              aria-label={option.title}
              aria-pressed={selected}
              className="h-9 min-w-0 flex-1 px-1.5 text-caption"
              key={option.key}
              onClick={() => onChange(option.effort)}
              size="sm"
              title={option.title}
              type="button"
              // "default" (bg-primary) é o realce forte do pacote ui, legível nos temas claro e escuro; "secondary" ficava sutil no escuro.
              variant={selected ? "default" : "outline"}
            >
              {option.label}
            </Button>
          )
        })}
      </ButtonGroup>
      <p className="text-caption text-muted-foreground">{t("reasoning.hint")}</p>
    </div>
  )
}
