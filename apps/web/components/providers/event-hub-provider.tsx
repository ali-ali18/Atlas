"use client"

import { usePathname } from "next/navigation"
import { useEffect } from "react"

import { startSharedEventHub } from "@/lib/event-hub-client"
import { isPublicWebPath } from "@/lib/public-paths"

/**
 * Liga o canal único de eventos do usuário (`GET /v1/events`) enquanto o app está aberto e logado.
 * O chat, a lista de bots e o painel "Em andamento" assinam o mesmo hub (`lib/event-hub-client`).
 */
export function EventHubProvider() {
  const pathname = usePathname()
  // Login e página pública de painel compartilhado não têm sessão: sem canal de eventos.
  const onLogin = pathname ? isPublicWebPath(pathname) : false
  useEffect(() => {
    if (onLogin) return
    return startSharedEventHub()
  }, [onLogin])
  return null
}
