"use client"

import { useMemo, useSyncExternalStore } from "react"

/**
 * Endereço da página "Remetentes permitidos" do e-mail do bot: `?remetentes=<botId>`.
 * Mesmo esquema do Marketplace: abrir empilha no histórico (voltar retorna à aba E-mail),
 * sem depender do router do Next.
 */
export const SENDERS_PARAM = "remetentes"
const CHANGE_EVENT = "atlas:email-senders-location"
const STATE_FLAG = "atlasEmailSenders"

export function parseSendersLocation(search: string): string | null {
  const raw = new URLSearchParams(search).get(SENDERS_PARAM)?.trim().slice(0, 120)
  return raw || null
}

export function buildSendersSearch(search: string, botId: string | null): string {
  const params = new URLSearchParams(search)
  params.delete(SENDERS_PARAM)
  if (botId) params.set(SENDERS_PARAM, botId)
  const text = params.toString()
  return text ? `?${text}` : ""
}

function write(botId: string | null, mode: "push" | "replace") {
  if (typeof window === "undefined") return
  const url = `${window.location.pathname}${buildSendersSearch(window.location.search, botId)}${window.location.hash}`
  if (mode === "push") window.history.pushState({ [STATE_FLAG]: true }, "", url)
  else window.history.replaceState(window.history.state, "", url)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function openSendersPage(botId: string) {
  write(botId, "push")
}

/** Volta para onde o usuário estava (a aba E-mail); em link direto, só fecha a página. */
export function closeSendersPage() {
  if (typeof window === "undefined") return
  const state = window.history.state as Record<string, unknown> | null
  if (state?.[STATE_FLAG] === true) window.history.back()
  else write(null, "replace")
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener("popstate", listener)
    window.removeEventListener(CHANGE_EVENT, listener)
  }
}

const getSearch = () => window.location.search
const getServerSearch = () => ""

/** Id do bot cuja página de remetentes está aberta, ou `null`. */
export function useSendersLocation(): string | null {
  const search = useSyncExternalStore(subscribe, getSearch, getServerSearch)
  return useMemo(() => parseSendersLocation(search), [search])
}
