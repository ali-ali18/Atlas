"use client"

import { useState } from "react"
import { cn } from "@workspace/ui/lib/utils"
import { connectorIconSrc } from "./connector-icon"

/**
 * Logo pequena de um app/conector (catálogo, MCP personalizado ou Composio). Sem logo,
 * ou se ela falhar, mostra a inicial do nome num círculo neutro (como a tela de Conectores).
 */
export function AppLogo({
  name,
  src,
  className,
}: {
  name: string
  src?: string | null
  className?: string
}) {
  const safe = connectorIconSrc(src)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!safe || failedSrc === safe) {
    const letter = (name.trim().charAt(0) || "?").toUpperCase()
    return (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-[10px] text-muted-foreground",
          className
        )}
        data-slot="app-logo-initial"
      >
        {letter}
      </span>
    )
  }
  return (
    // Logo estática do app ou externa (https), carregada no navegador sem proxy de otimização.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt=""
      className={cn("shrink-0 rounded-sm object-contain", className)}
      data-slot="app-logo"
      loading="lazy"
      onError={() => setFailedSrc(safe)}
      referrerPolicy="no-referrer"
      src={safe}
    />
  )
}
