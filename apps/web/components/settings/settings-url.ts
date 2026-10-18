"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
	DEFAULT_SETTINGS_SECTION,
	SETTINGS_URL_PARAM,
	type SettingsSectionId,
	buildSettingsSearch,
	parseSettingsParam,
	resolveSettingsSection,
} from "./settings-registry";

/**
 * Muda só o `?settings=` da URL atual. `replaceState` integra com o router do
 * Next (atualiza `useSearchParams`) sem navegar nem empilhar histórico.
 */
export function writeSettingsSection(section: SettingsSectionId | null) {
	const search = buildSettingsSearch(window.location.search, section);
	window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
}

/** Abre o modal de qualquer lugar (menu da conta etc.). Aceita também os ids antigos (`composio`, `ambientes`…). */
export function openSettingsModal(section: string = DEFAULT_SETTINGS_SECTION) {
	writeSettingsSection(resolveSettingsSection(section) ?? DEFAULT_SETTINGS_SECTION);
}

/** Query que abre o formulário "Novo login" do Cofre já com o site preenchido (lida e removida pelo Cofre). */
export const VAULT_NEW_LOGIN_PARAM = "vaultSite";

/** "Salvar um login no Cofre": abre Configurações → Cofre → Novo login com o domínio pré-preenchido. */
export function openVaultNewLogin(site: string) {
	const url = new URL(window.location.href);
	url.searchParams.set(VAULT_NEW_LOGIN_PARAM, site.slice(0, 120));
	window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
	openSettingsModal("cofre");
}

/** Evento que qualquer tela dispara para pedir o modal onde mora o ChatGPT (Provedores e planos; ex.: "Conectar ChatGPT" do seletor). */
export const OPEN_PROVIDER_SETTINGS_EVENT = "atlas:open-provider-settings";

export function requestProviderSettings() {
	window.dispatchEvent(new Event(OPEN_PROVIDER_SETTINGS_EVENT));
}

/** Escuta o pedido acima e abre o modal em `?settings=provedores`. Devolve o cancelamento. */
export function listenForProviderSettings(target: EventTarget = window): () => void {
	const open = () => openSettingsModal("provedores");
	target.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
	return () => target.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
}

/** Seção aberta vem da URL: recarregar mantém; `null` = modal fechado. */
export function useSettingsSection(): {
	section: SettingsSectionId | null;
	setSection: (section: SettingsSectionId | null) => void;
} {
	const section = parseSettingsParam(useSearchParams().get(SETTINGS_URL_PARAM));
	const setSection = useCallback((next: SettingsSectionId | null) => writeSettingsSection(next), []);
	return { section, setSection };
}
