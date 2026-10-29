/**
 * Tradutor tipado e sem dependências. Módulo puro (sem React): usado pelo provider, por funções
 * que montam texto para a tela e por testes.
 *
 * - Chaves vêm do dicionário pt-BR (fonte da verdade): chave inexistente não compila.
 * - Os `{parametros}` do texto pt-BR viram parâmetros obrigatórios e tipados de `t`.
 * - Plural: chaves `<base>.one` / `<base>.other` (e `zero`/`few`/`many` quando o idioma pedir) com `tn`.
 */
import { DEFAULT_UI_LOCALE, type UiLocale } from "./locales";
import { ptBR } from "./messages/pt-BR";

export type Messages = typeof ptBR;
export type MessageKey = keyof Messages;
/** Forma que todo idioma precisa ter: uma string para cada chave do pt-BR. */
export type MessageDictionary = Record<MessageKey, string>;
/** Dicionário de um namespace de outro idioma, amarrado às chaves do namespace pt-BR. */
export type NamespaceMessages<T extends Record<string, string>> = Record<keyof T, string>;

type ParamNames<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;
export type MessageParams<K extends MessageKey> = [ParamNames<Messages[K]>] extends [never]
	? []
	: [params: Record<ParamNames<Messages[K]>, string | number>];

type PluralBases<K> = K extends `${infer Base}.other` ? Base : never;
/** Bases de plural: toda chave que termina em `.other`. */
export type PluralKey = PluralBases<MessageKey>;
type PluralParams<B extends PluralKey> = [Exclude<ParamNames<Messages[`${B}.other` & MessageKey]>, "count">] extends [never]
	? [params?: Record<string, string | number>]
	: [params: Record<Exclude<ParamNames<Messages[`${B}.other` & MessageKey]>, "count">, string | number>];

export type TFunction = <K extends MessageKey>(key: K, ...params: MessageParams<K>) => string;
export type TnFunction = <B extends PluralKey>(base: B, count: number, ...params: PluralParams<B>) => string;

export type Translator = { locale: UiLocale; t: TFunction; tn: TnFunction };

export function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/**
 * `messages` do idioma pedido; o que faltar cai no pt-BR (nunca mostra a chave crua a um usuário
 * por causa de uma tradução atrasada). `fallback` só muda em teste.
 */
export function createTranslator(
	locale: UiLocale,
	messages: Partial<MessageDictionary> | null = null,
	fallback: MessageDictionary = ptBR,
): Translator {
	const lookup = (key: string): string => (messages as Record<string, string> | null)?.[key] ?? (fallback as Record<string, string>)[key] ?? key;
	const has = (key: string): boolean => key in ((messages ?? fallback) as Record<string, string>) || key in fallback;
	const t = ((key: string, params?: Record<string, string | number>) => interpolate(lookup(key), params)) as TFunction;
	const rules = new Intl.PluralRules(locale);
	const tn = ((base: string, count: number, params?: Record<string, string | number>) => {
		const category = rules.select(count);
		const key = has(`${base}.${category}`) ? `${base}.${category}` : `${base}.other`;
		return interpolate(lookup(key), { ...params, count });
	}) as TnFunction;
	return { locale, t, tn };
}

/** Tradutor pt-BR: padrão fora do provider (testes e código que roda antes de a tela montar). */
export const defaultTranslator: Translator = createTranslator(DEFAULT_UI_LOCALE);
