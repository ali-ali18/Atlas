"use client"

import { useState } from "react"
import { PlugIcon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"

/** URLs externas de marca nunca carregam credenciais nem enviam o referer. */
export function composioLogoUrl(raw: string | null | undefined): string | null {
  try {
    const url = new URL(raw ?? "")
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

export function ComposioAppIcon({
  logo,
  className,
}: {
  logo?: string | null
  className?: string
}) {
  const src = composioLogoUrl(logo)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src)
    return <PlugIcon aria-hidden className={className} />
  return (
    // Imagem externa carregada no navegador, sem proxy de otimização do servidor.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt=""
      className={cn("object-contain", className)}
      src={src}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  )
}
