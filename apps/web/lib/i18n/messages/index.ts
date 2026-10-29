/**
 * Carregador dos dicionários, um por idioma (import dinâmico: o cliente só baixa o idioma da tela).
 * Idioma novo = uma linha aqui + a pasta `messages/<id>/`.
 */
import type { UiLocale } from "../locales";
import type { MessageDictionary } from "../translator";

const loaders: Record<UiLocale, () => Promise<MessageDictionary>> = {
	"pt-BR": () => import("./pt-BR").then((module) => module.ptBR),
	"en-US": () => import("./en-US").then((module) => module.enUS),
	"es-ES": () => import("./es-ES").then((module) => module.esES),
};

export function loadMessages(locale: UiLocale): Promise<MessageDictionary> {
	return loaders[locale]();
}
