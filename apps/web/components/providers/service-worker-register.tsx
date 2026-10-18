"use client"

import { useEffect } from "react"

/** Registra o service worker (notificações push e toque que abre a conversa). Sem suporte, não faz nada. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("service worker não registrado", error instanceof Error ? error.message : error)
    })
  }, [])
  return null
}
