"use client"

import { useState } from "react"
import { PlugIcon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import { composioLogoUrl } from "./composio-app-icon"

/** Ícone do catálogo (`/connectors/x.svg`, do próprio app) ou logo HTTPS do Composio. */
export function connectorIconSrc(raw: string | null | undefined): string | null {
  if (typeof raw === "string" && /^\/(?!\/)[A-Za-z0-9._\-/]+$/.test(raw) && !raw.includes("..")) return raw
  return composioLogoUrl(raw)
}

export function ConnectorIcon({
  src,
  className,
}: {
  src?: string | null
  className?: string
}) {
  const safe = connectorIconSrc(src)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!safe || failedSrc === safe)
    return <PlugIcon aria-hidden className={className} />
  return (
    // Imagem de marca estática ou logo externo, sem proxy de otimização do servidor.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt=""
      className={cn("object-contain", className)}
      src={safe}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailedSrc(safe)}
    />
  )
}
