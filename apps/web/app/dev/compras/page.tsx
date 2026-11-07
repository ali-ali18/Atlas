import { notFound } from "next/navigation"

import { PurchasePreview } from "@/components/ai-elements/purchase/purchase-preview"

/**
 * Página SÓ de prévia (capturas de tela do cartão de compra). Sem `ATLAS_PREVIEW_PAGES=1` no servidor ela não existe (404),
 * então nunca aparece em produção. Usada por `e2e/compras-previews.spec.ts`.
 */
export default function ComprasPreviewPage() {
  if (process.env.ATLAS_PREVIEW_PAGES !== "1") notFound()
  return <PurchasePreview />
}
