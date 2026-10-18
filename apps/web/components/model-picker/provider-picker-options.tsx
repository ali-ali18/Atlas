"use client"
import type { ProviderModel, ProviderStatus } from "@workspace/shared"
import {
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector"
import { PickerModelRow, ProviderModelList } from "./provider-model-list"
export function ProviderPickerOptions({
  value,
  models,
  query,
  available,
  status,
  catalogAvailable,
  emptyLabel,
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
  onSelect: (id: string) => void
  onConnect: () => void
}) {
  const current = models.find((model) => model.id === value)
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
      <ProviderModelList
        models={models}
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
