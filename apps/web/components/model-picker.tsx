"use client"
import { Spinner } from "@workspace/ui/components/spinner";
import { ChevronDownIcon } from "lucide-react"
import { type ReactElement, useState } from "react"
import { getModelCapabilities, modelDisplayName, type OpenRouterModel, type ReasoningEffort } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import { useTranslations } from "@/lib/i18n/provider"
import { requestProviderSettings } from "@/components/settings/settings-url"
import { useChatgptProvider } from "@/hooks/use-chatgpt-provider"
import { useKeyProviderModels } from "@/hooks/use-provider-keys"
import { normalizePickerModels, pickerLogoOf, pickerViaLabel } from "@/lib/provider-model-picker"
import { ProviderPickerOptions } from "./model-picker/provider-picker-options"
import { ReasoningEffortControl } from "./model-picker/reasoning-effort-control"
import { reasoningChoicesFor, shownReasoningEffort } from "@/lib/reasoning-effort"

export function ModelPicker({
  value,
  onChange,
  models,
  loading = false,
  className,
  showLogo = true,
  trigger,
  emptyLabel,
  onConnectChatgpt,
  openrouterOnly = false,
  noChatgpt = false,
  requireImage = false,
  id,
  suggestedIds,
  suggestedHeading,
  reasoning,
}: {
  emptyLabel?: string
  value: string
  onChange: (modelId: string) => void
  models: OpenRouterModel[]
  loading?: boolean
  className?: string
  showLogo?: boolean
  trigger?: ReactElement
  onConnectChatgpt?: () => void
  /** Só modelos do OpenRouter (manutenção, visão, imagem, reserva): sem grupo ChatGPT. */
  openrouterOnly?: boolean
  /** Todos os provedores com chave (OpenRouter, Anthropic, OpenCode Go), menos o plano ChatGPT (manutenção). */
  noChatgpt?: boolean
  /** Dos provedores por chave, só os que leem imagem (modelo para ler imagens). */
  requireImage?: boolean
  id?: string
  /** Modelos em destaque no topo da lista (ex.: os cadastrados nos níveis de dificuldade). */
  suggestedIds?: string[]
  suggestedHeading?: string
  /**
   * Nível de raciocínio do chat. Com ele, escolher um modelo que aceita níveis mantém o seletor aberto e mostra
   * "Raciocínio" logo abaixo da lista; modelo sem suporte (e Automático) não mostra o controle.
   */
  reasoning?: { effort: ReasoningEffort | undefined; onChange: (effort: ReasoningEffort | undefined) => void }
}) {
  const translator = useTranslations()
  const { t } = translator
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const provider = useChatgptProvider(
    value.startsWith("chatgpt/") ? value : undefined,
    true,
    !openrouterOnly && !noChatgpt
  )
  const keyGroups = useKeyProviderModels(!openrouterOnly)
  const keyModels = Object.values(keyGroups)
    .flat()
    .filter((model) => !requireImage || getModelCapabilities(model.id, model as never).vision)
  const available = normalizePickerModels(
    openrouterOnly
      ? models
      : [...models, ...(noChatgpt ? [] : provider.models), ...keyModels]
  )
  const current = available.find((model) => model.id === value)
  const isEmpty = emptyLabel !== undefined && !value
  const logo = current
    ? pickerLogoOf(current)
    : value.startsWith("chatgpt/")
      ? "openai"
      : value.startsWith("anthropic-direct/")
        ? "anthropic"
        : value.startsWith("opencode-go/")
          ? "opencode"
          : value.split("/")[0]
  const shownName = isEmpty
    ? emptyLabel
    : current
      ? modelDisplayName(current.name, current.id)
      : value || t("modelPicker.choose")
  const via = isEmpty ? null : pickerViaLabel(current?.id ?? value, translator)
  const catalogOf = (id: string) => available.find((model) => model.id === id)
  const choices = reasoning ? reasoningChoicesFor(value, catalogOf(value)) : []
  const select = (id: string) => {
    onChange(id)
    // O controle de raciocínio aparece para o modelo recém-escolhido: o seletor fica aberto para ajustá-lo.
    if (reasoning && reasoningChoicesFor(id, catalogOf(id)).length > 0) return
    setOpen(false)
  }
  const connect = () => {
    setOpen(false)
    if (onConnectChatgpt) onConnectChatgpt()
    else requestProviderSettings()
  }
  return (
    <ModelSelector
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <ModelSelectorTrigger
        render={
          trigger ?? (
            <Button
              id={id}
              data-model-picker=""
              className={cn(
                "h-9 w-full justify-between gap-2 font-normal",
                className
              )}
              variant="outline"
            />
          )
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {showLogo && !isEmpty && logo ? (
            <ModelSelectorLogo provider={logo} />
          ) : null}
          <span className="truncate" title={shownName}>
            {shownName}
          </span>
          {via ? (
            <span className="shrink-0 text-xs text-muted-foreground">{via}</span>
          ) : null}
        </span>
        {loading ? (
          <Spinner className="size-4 shrink-0 opacity-60" />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
        )}
      </ModelSelectorTrigger>
      <ModelSelectorContent
        className="sm:max-w-lg"
        title={t("modelPicker.choose")}
        commandProps={{ shouldFilter: false }}
      >
        <ModelSelectorInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("modelPicker.searchAll")}
        />
        <ModelSelectorList>
          <ProviderPickerOptions
            value={value}
            models={available}
            query={query}
            available={!openrouterOnly && !noChatgpt && provider.available}
            status={provider.status}
            catalogAvailable={provider.catalogAvailable}
            emptyLabel={emptyLabel}
            suggestedIds={suggestedIds}
            suggestedHeading={suggestedHeading}
            onSelect={select}
            onConnect={connect}
          />
        </ModelSelectorList>
        {reasoning && choices.length > 0 ? (
          <div className="flex flex-col gap-3 border-t p-3">
            <ReasoningEffortControl
              choices={choices}
              onChange={reasoning.onChange}
              value={shownReasoningEffort(reasoning.effort, value, catalogOf(value))}
            />
            <Button className="self-end" onClick={() => setOpen(false)} size="sm" type="button" variant="secondary">
              {t("reasoning.done")}
            </Button>
          </div>
        ) : null}
      </ModelSelectorContent>
    </ModelSelector>
  )
}
