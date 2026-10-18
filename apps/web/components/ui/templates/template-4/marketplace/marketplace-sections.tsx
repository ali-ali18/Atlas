"use client"

import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import {
  MARKETPLACE_SECTIONS,
  MARKETPLACE_SECTION_LABELS,
  type MarketplaceSection,
} from "@/lib/marketplace-url"

/**
 * Seções do Marketplace no topo da página, centradas: Conectores · Apps · Agentes · Habilidades.
 * Mesmo controle segmentado das abas Geral/Memória das configurações do agente (rótulos curtos
 * para caberem em 390px sem rolar).
 */
export function MarketplaceSections({
  section,
  onChange,
}: {
  section: MarketplaceSection
  onChange: (section: MarketplaceSection) => void
}) {
  return (
    <Tabs
      className="items-center"
      onValueChange={(next) => onChange(next as MarketplaceSection)}
      value={section}
    >
      <TabsList aria-label="Seções do marketplace" className="max-w-full">
        {MARKETPLACE_SECTIONS.map((id) => (
          <TabsTrigger
            aria-controls={`marketplace-panel-${id}`}
            className="px-3 md:px-4"
            id={`marketplace-section-${id}`}
            key={id}
            value={id}
          >
            {MARKETPLACE_SECTION_LABELS[id]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
