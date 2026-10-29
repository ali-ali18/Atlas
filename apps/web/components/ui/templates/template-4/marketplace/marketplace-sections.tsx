"use client"

import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { useTranslations } from "@/lib/i18n/provider"
import { MARKETPLACE_SECTIONS, type MarketplaceSection } from "@/lib/marketplace-url"

const SECTION_KEYS = {
  conectores: "marketplace.sections.conectores",
  apps: "marketplace.sections.apps",
  agentes: "marketplace.sections.agentes",
  habilidades: "marketplace.sections.habilidades",
} as const satisfies Record<MarketplaceSection, `marketplace.sections.${MarketplaceSection}`>

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
  const { t } = useTranslations()
  return (
    <Tabs
      className="items-center"
      onValueChange={(next) => onChange(next as MarketplaceSection)}
      value={section}
    >
      <TabsList aria-label={t("marketplace.sections.label")} className="max-w-full">
        {MARKETPLACE_SECTIONS.map((id) => (
          <TabsTrigger
            aria-controls={`marketplace-panel-${id}`}
            className="px-3 md:px-4"
            id={`marketplace-section-${id}`}
            key={id}
            value={id}
          >
            {t(SECTION_KEYS[id])}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
