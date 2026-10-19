"use client"
import type { ProviderModel, ProviderStatus } from "@workspace/shared"
import {
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector"
import { searchPickerModels } from "@/lib/provider-model-picker"
import { PickerModelRow, ProviderModelList } from "./provider-model-list"
export function ProviderPickerOptions({
  value,
  models,
  query,
  available,
  status,
  catalogAvailable,
  emptyLabel,
  suggestedIds,
  suggestedHeading = "Seus modelos",
  onSelect,
  onConnect,
}: {
  value: string
  models: ProviderModel[]
  query: string
  available: boolean
  status: ProviderStatus | null
  catalogAvailable: boolean
  emptyLabel?: string
  suggestedIds?: string[]
  suggestedHeading?: string
  onSelect: (id: string) => void
  onConnect: () => void
}) {
  const current = models.find((model) => model.id === value)
  const suggested = (suggestedIds ?? []).map(
    (id) => models.find((model) => model.id === id) ?? null
  )
  const suggestedModels = searchPickerModels(
    suggested.filter((model): model is ProviderModel => model !== null),
    query
  )
  const suggestedSet = new Set(suggestedModels.map((model) => model.id))
  return (
    <>
      {value ? (
        <ModelSelectorGroup heading="Modelo atual">
          {current ? (
            <PickerModelRow model={current} onSelect={onSelect} />
          ) : (
            <ModelSelectorItem value={value} onSelect={() => onSelect(value)}>
              <ModelSelectorName>{value}</ModelSelectorName>
            </ModelSelectorItem>
          )}
          {value.startsWith("chatgpt/") &&
          (!available || status?.status !== "connected") ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              {status?.status === "needs_login"
                ? "Reconecte o ChatGPT nas configurações."
                : "ChatGPT indisponível. Confira a conexão nas configurações."}
            </p>
          ) : null}
        </ModelSelectorGroup>
      ) : null}
      {emptyLabel !== undefined ? (
        <ModelSelectorGroup>
          <ModelSelectorItem value="__default__" onSelect={() => onSelect("")}>
            <ModelSelectorName>{emptyLabel}</ModelSelectorName>
          </ModelSelectorItem>
        </ModelSelectorGroup>
      ) : null}
      {suggestedModels.length > 0 ? (
        <ModelSelectorGroup heading={suggestedHeading}>
          {suggestedModels.map((model) => (
            <PickerModelRow key={model.id} model={model} onSelect={onSelect} />
          ))}
        </ModelSelectorGroup>
      ) : null}
      <ProviderModelList
        models={models.filter((model) => !suggestedSet.has(model.id))}
        currentId={value}
        query={query}
        chatgptAvailable={available}
        status={status}
        catalogAvailable={catalogAvailable}
        onSelect={onSelect}
        onConnect={onConnect}
      />
    </>
  )
}
