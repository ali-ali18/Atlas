"use client"

import { useState } from "react"
import { customMcpIconPath } from "@workspace/shared"
import { cn } from "@workspace/ui/lib/utils"

/** Host público de uma URL MCP, ou `null` se ainda não é uma URL válida. */
export function customMcpHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
  } catch {
    return null
  }
}

/**
 * Logo de um servidor MCP personalizado. A imagem vem da nossa API (que busca
 * e valida o ícone do site); sem imagem, mostra a inicial do nome.
 */
export function CustomMcpIcon({
  name,
  url,
  src,
  className,
}: {
  name: string
  url?: string | null
  /** Caminho já resolvido pelo servidor (`/v1/mcp/icon/<host>`); senão deriva da URL. */
  src?: string | null
  className?: string
}) {
  const host = customMcpHost(url)
  const path = src && src.startsWith("/v1/mcp/icon/") ? src : host ? customMcpIconPath(host) : null
  const [failed, setFailed] = useState<string | null>(null)
  const letter = (name.trim().charAt(0) || "?").toUpperCase()
  if (!path || failed === path)
    return (
      <span
        aria-hidden
        className={cn(
          "grid place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground",
          className
        )}
      >
        {letter}
      </span>
    )
  return (
    // Logo servida pela nossa API (proxy com cache), nunca direto do site de terceiros.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt=""
      className={cn("object-contain", className)}
      loading="lazy"
      onError={() => setFailed(path)}
      src={path}
    />
  )
}
