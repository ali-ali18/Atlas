/**
 * Tradutor "da vez" para código que não é componente (hooks de erro, `atlas-api.ts`, funções de
 * `lib/` chamadas dentro de handlers). O `I18nProvider` registra o do idioma da tela no navegador;
 * sem provider (testes, servidor) vale o pt-BR. Como trocar de idioma recarrega a página, o valor
 * nunca fica velho. Funções puras com texto recebem `translator = getActiveTranslator()` por
 * parâmetro: quem já tem `t` na mão passa, os outros chamadores seguem iguais.
 */
import { defaultTranslator, type MessageKey, type Translator } from "./translator";

let active: Translator = defaultTranslator;

/** Só no navegador: no servidor o módulo é compartilhado entre requisições. */
export function setActiveTranslator(translator: Translator): void {
	if (typeof window !== "undefined") active = translator;
}

export function getActiveTranslator(): Translator {
	return active;
}

/** Atalho: `activeT("errors.loadUsage")` fora de componente. */
export const activeT: Translator["t"] = (key, ...params) => active.t(key, ...params);

/** Para chave montada em tempo de execução (só vale para texto sem `{parametro}`). */
export function activeLabel(key: MessageKey): string {
	return (active.t as (key: MessageKey) => string)(key);
}
