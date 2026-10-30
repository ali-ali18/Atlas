import type { MetadataRoute } from "next"

import { getTranslations } from "@/lib/i18n/server"
import { webManifest } from "@/lib/web-manifest"

/**
 * Lê cookie/header (idioma da interface), então a rota é dinâmica (sem cache estático): o manifesto é
 * pequeno e o navegador o busca com os cookies do mesmo site.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { t } = await getTranslations()
  return webManifest(t("app.manifestDescription"))
}
