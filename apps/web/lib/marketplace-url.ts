"use client"

import { useMemo, useSyncExternalStore } from "react"

/**
 * Endereço do Marketplace (página dentro do shell, como o modal de Configurações):
 * `?marketplace=<seção>` e, num detalhe, `&item=<id>`. Abrir e entrar num detalhe
 * empilham no histórico (voltar/gesto de voltar retorna a onde o usuário estava);
 * trocar de seção só substitui a entrada. Sem dependência do router do Next: o estado
 * vem de `window.location` e de um evento próprio, então funciona em qualquer tela.
 */

export const MARKETPLACE_PARAM = "marketplace"
export const MARKETPLACE_ITEM_PARAM = "item"
export const MARKETPLACE_SECTIONS = ["conectores", "apps", "agentes", "habilidades"] as const
export type MarketplaceSection = (typeof MARKETPLACE_SECTIONS)[number]
export type MarketplaceLocation = { section: MarketplaceSection; item: string | null }

export const MARKETPLACE_SECTION_LABELS: Record<MarketplaceSection, string> = {
  conectores: "Conectores",
  apps: "Apps",
  agentes: "Agentes",
  habilidades: "Habilidades",
}

/** Última seção aberta neste aparelho (abrir o Marketplace sem pedir uma seção volta a ela). */
export const MARKETPLACE_LAST_SECTION_KEY = "atlas.marketplace.section"

const CHANGE_EVENT = "atlas:marketplace-location"
/** Marca nas entradas de histórico que o Marketplace empilhou (voltar sai dele sem sair do app). */
const STATE_FLAG = "atlasMarketplace"

/** `?marketplace=skills&item=roblox` -> { section, item }; sem o parâmetro, `null`. Valor desconhecido vira Conectores. */
export function parseMarketplaceLocation(search: string): MarketplaceLocation | null {
  const params = new URLSearchParams(search)
  const raw = params.get(MARKETPLACE_PARAM)
  if (raw === null) return null
  const section = (MARKETPLACE_SECTIONS as readonly string[]).includes(raw) ? (raw as MarketplaceSection) : raw === "skills" ? "habilidades" : "conectores"
  const item = params.get(MARKETPLACE_ITEM_PARAM)?.trim().slice(0, 120) || null
  return { section, item }
}

/** Nova query a partir da atual: troca só os parâmetros do Marketplace; `null` remove. */
export function buildMarketplaceSearch(search: string, location: MarketplaceLocation | null): string {
  const params = new URLSearchParams(search)
  params.delete(MARKETPLACE_PARAM)
  params.delete(MARKETPLACE_ITEM_PARAM)
  if (location) {
    params.set(MARKETPLACE_PARAM, location.section)
    if (location.item) params.set(MARKETPLACE_ITEM_PARAM, location.item)
  }
  const text = params.toString()
  return text ? `?${text}` : ""
}

export function rememberedSection(): MarketplaceSection | null {
  try {
    const raw = window.localStorage.getItem(MARKETPLACE_LAST_SECTION_KEY)
    return (MARKETPLACE_SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as MarketplaceSection) : null
  } catch {
    return null
  }
}

function remember(section: MarketplaceSection) {
  try {
    window.localStorage.setItem(MARKETPLACE_LAST_SECTION_KEY, section)
  } catch {
    // Sem storage (modo privado): a seção só não é lembrada.
  }
}

function write(location: MarketplaceLocation | null, mode: "push" | "replace") {
  if (typeof window === "undefined") return
  const search = buildMarketplaceSearch(window.location.search, location)
  const url = `${window.location.pathname}${search}${window.location.hash}`
  if (mode === "push") window.history.pushState({ [STATE_FLAG]: true }, "", url)
  else window.history.replaceState(window.history.state, "", url)
  if (location) remember(location.section)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Abre o Marketplace (ou um detalhe). Empilha no histórico, exceto trocar de seção dentro dele. */
export function openMarketplacePage(target: { section?: MarketplaceSection; item?: string | null } = {}) {
  if (typeof window === "undefined") return
  const current = parseMarketplaceLocation(window.location.search)
  const section = target.section ?? current?.section ?? rememberedSection() ?? "conectores"
  const item = target.item ?? null
  // Já aberto e indo para uma lista (trocar de seção, voltar à lista) só substitui a entrada; entrar num detalhe ou abrir empilha.
  write({ section, item }, current && !item ? "replace" : "push")
}

/** O Marketplace foi aberto empilhando uma entrada (voltar do navegador retorna ao ponto de origem)? */
export function canGoBackInMarketplace(): boolean {
  if (typeof window === "undefined") return false
  const state = window.history.state as Record<string, unknown> | null
  return state?.[STATE_FLAG] === true
}

/** Volta um passo: no detalhe, à lista; na lista, sai do Marketplace para onde o usuário estava. */
export function goBackFromMarketplace() {
  if (typeof window === "undefined") return
  if (canGoBackInMarketplace()) {
    window.history.back()
    return
  }
  const current = parseMarketplaceLocation(window.location.search)
  // Entrada aberta por link direto: sem de onde voltar, então detalhe -> lista e lista -> fecha.
  write(current?.item ? { section: current.section, item: null } : null, "replace")
}

/** Fecha o Marketplace de vez (ex.: "Abrir conversa" depois de instalar um agente). */
export function closeMarketplacePage() {
  if (typeof window === "undefined") return
  write(null, "replace")
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

/** Estado do Marketplace pela URL (re-renderiza ao abrir, navegar e voltar). */
export function useMarketplaceLocation(): MarketplaceLocation | null {
  const search = useSyncExternalStore(subscribe, getSearch, getServerSearch)
  return useMemo(() => parseMarketplaceLocation(search), [search])
}
