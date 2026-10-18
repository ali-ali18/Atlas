"use client"
import {
  getModelCapabilities,
  modelDisplayName,
  type ProviderModel,
  type ProviderStatus,
} from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { ModelCapabilityBadges } from "@workspace/ui/components/model-capability-badges"
import { ChevronDownIcon } from "lucide-react"
import {
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector"
import { groupModelsByProvider, providerLabel } from "@/lib/openrouter-models"
import {
  KEY_GROUP_LABEL,
  pickerLogoOf,
  pickerRecommendations,
  searchPickerModels,
  pickerViaLabel,
} from "@/lib/provider-model-picker"

export function PickerModelRow({
  model,
  onSelect,
}: {
  model: ProviderModel
  onSelect: (id: string) => void
}) {
  const name = model.name.includes(": ")
    ? model.name.slice(model.name.indexOf(": ") + 2)
    : model.name
  const via = pickerViaLabel(model.id)
  return (
    <ModelSelectorItem
      value={model.id}
      keywords={[model.name, model.id]}
      onSelect={() => onSelect(model.id)}
    >
      <ModelSelectorLogo provider={pickerLogoOf(model) as never} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <ModelSelectorName>{name}</ModelSelectorName>
          {via ? (
            <span className="shrink-0 text-xs text-muted-foreground">{via}</span>
          ) : null}
        </span>
        <ModelCapabilityBadges
          capabilities={getModelCapabilities(model.id, model)}
        />
      </span>
    </ModelSelectorItem>
  )
}

export function ProviderGroup({
  name,
  count,
  children,
}: {
  name: string
  count: number
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={false} className="border-t border-border/60">
      <CollapsibleTrigger
        render={<Button variant="ghost" />}
        aria-label={`Mostrar modelos de ${name}`}
        className="h-10 w-full justify-between rounded-none px-3 text-sm font-medium"
      >
        <span>
          {name}{" "}
          <span className="ml-1 text-xs text-muted-foreground">{count}</span>
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function chatgptGroupMessage(
  status: ProviderStatus | null,
  catalogAvailable: boolean
): string | null {
  if (status?.status === "needs_login") return "Reconecte o ChatGPT"
  if (status?.status !== "connected") return "Conectar ChatGPT"
  return catalogAvailable ? null : "Catálogo temporariamente indisponível."
}

export function ProviderModelList({
  models,
  currentId,
  query,
  chatgptAvailable,
  status,
  catalogAvailable,
  onSelect,
  onConnect,
}: {
  models: ProviderModel[]
  currentId: string
  query: string
  chatgptAvailable: boolean
  status: ProviderStatus | null
  catalogAvailable: boolean
  onSelect: (id: string) => void
  onConnect: () => void
}) {
  const others = models.filter(
    (model) =>
      model.id !== currentId &&
      (chatgptAvailable || model.provider !== "chatgpt")
  )
  if (query.trim()) {
    const results = searchPickerModels(others, query)
    return (
      <ModelSelectorGroup heading="Resultados">
        {results.length ? (
          results.map((model) => (
            <PickerModelRow key={model.id} model={model} onSelect={onSelect} />
          ))
        ) : (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            Nenhum modelo encontrado.
          </p>
        )}
      </ModelSelectorGroup>
    )
  }
  const openrouter = others.filter((model) => model.provider === "openrouter")
  const recommended = pickerRecommendations(openrouter)
  const recommendedIds = new Set(recommended.map((model) => model.id))
  const vendors = groupModelsByProvider(
    openrouter.filter((model) => !recommendedIds.has(model.id))
  )
  const chatgpt = others.filter((model) => model.provider === "chatgpt")
  // Provedores por chave própria: o grupo só existe quando conectado (há modelos).
  const keyed = (["anthropic", "opencode-go"] as const).map((provider) => ({
    provider,
    items: others.filter((model) => model.provider === provider),
  }))
  const message = chatgptGroupMessage(status, catalogAvailable)
  return (
    <>
      <ProviderGroup
        name="OpenRouter"
        count={models.filter((model) => model.provider === "openrouter").length}
      >
        {recommended.length ? (
          <ModelSelectorGroup heading="Recomendados">
            {recommended.map((model) => (
              <PickerModelRow
                key={model.id}
                model={model}
                onSelect={onSelect}
              />
            ))}
          </ModelSelectorGroup>
        ) : null}
        {Object.entries(vendors).map(([vendor, items]) => (
          <ModelSelectorGroup key={vendor} heading={providerLabel(vendor)}>
            {items.map((model) => (
              <PickerModelRow
                key={model.id}
                model={model}
                onSelect={onSelect}
              />
            ))}
          </ModelSelectorGroup>
        ))}
        {!openrouter.length ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            Nenhum outro modelo disponível.
          </p>
        ) : null}
      </ProviderGroup>
      {keyed.map(({ provider, items }) =>
        items.length ? (
          <ProviderGroup
            key={provider}
            name={KEY_GROUP_LABEL[provider]}
            count={models.filter((model) => model.provider === provider).length}
          >
            {items.map((model) => (
              <PickerModelRow key={model.id} model={model} onSelect={onSelect} />
            ))}
          </ProviderGroup>
        ) : null
      )}
      {chatgptAvailable ? (
        <ProviderGroup
          name="ChatGPT (plano)"
          count={models.filter((model) => model.provider === "chatgpt").length}
        >
          {message ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">
              {status?.status === "connected" ? (
                message
              ) : (
                <Button
                  variant="ghost"
                  className="h-auto px-0"
                  onClick={onConnect}
                >
                  {message}
                </Button>
              )}
            </div>
          ) : null}
          {chatgpt.map((model) => (
            <PickerModelRow key={model.id} model={model} onSelect={onSelect} />
          ))}
          {!message && !chatgpt.length ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Nenhum outro modelo disponível.
            </p>
          ) : null}
        </ProviderGroup>
      ) : null}
    </>
  )
}
