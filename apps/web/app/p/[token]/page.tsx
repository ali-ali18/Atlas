import type { Metadata } from "next"

import { PublicPage } from "@/components/public-page/public-page"
import { getTranslations } from "@/lib/i18n/server"

/** Painel compartilhado por link público: só leitura, fora dos buscadores e sem repassar o endereço (referrer). */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslations()
  return {
    title: t("library.public.title"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  }
}

export default async function SharedPagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <PublicPage token={token} />
}
