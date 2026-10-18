"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { DiagnosticsView } from "@workspace/shared"
import { getDiagnostics } from "@/lib/diagnostics-api"

/** Carrega o diagnóstico ao abrir e quando o usuário pede para atualizar; ignora respostas antigas. */
export function useDiagnostics(enabled = true) {
  const [data, setData] = useState<DiagnosticsView | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const refresh = useCallback(() => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    getDiagnostics()
      .then((view) => {
        if (request === requestRef.current) setData(view)
      })
      .catch((cause: unknown) => {
        if (request === requestRef.current) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o diagnóstico.")
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, refresh])

  return { data, loading, error, refresh }
}
