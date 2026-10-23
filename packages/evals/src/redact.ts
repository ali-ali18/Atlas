import { redactSecrets } from "@workspace/shared";

/**
 * Redação por padrão de um run de produção antes de virar cenário versionado: segredos (tokens, chaves) somem;
 * e-mails, telefones, CPFs e CNPJs viram marcadores com o mesmo formato. O mesmo valor original vira sempre o mesmo
 * marcador dentro de um cenário, para a conversa continuar coerente (o CNPJ colado e o citado depois batem).
 */

const EXTRA_SECRETS: RegExp[] = [
	/\b(?:sk|pk|rk)-(?:or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/((?:[?&;]|\b)(?:access_token|refresh_token|api[-_]?key|apikey|token|secret|password|signature|sig|code|state)=)[^&#\s"']+/gi,
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g;
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g;
/** Telefone BR com DDD ((41) 99999-1234, 41 3333-1234, +55 41 99999-1234) ou internacional com "+". */
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2}\)\s?|\b\d{2}[\s-])9?\d{4}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,5}[\s-]?\d{3,5}\b/g;

const pad = (value: number, size: number) => String(value).padStart(size, "0");

export type Redactor = { text: (value: string) => string; deep: <T>(value: T) => T; counts: () => Record<string, number> };

export function createRedactor(): Redactor {
	const maps: Record<string, Map<string, string>> = { email: new Map(), cnpj: new Map(), cpf: new Map(), phone: new Map(), secret: new Map() };
	const placeholder = (kind: keyof typeof maps, original: string, make: (n: number) => string) => {
		const map = maps[kind]!;
		let value = map.get(original);
		if (!value) {
			value = make(map.size + 1);
			map.set(original, value);
		}
		return value;
	};
	const text = (value: string): string => {
		let out = redactSecrets(value);
		for (const pattern of EXTRA_SECRETS) {
			out = out.replace(pattern, (match, prefix?: unknown) => {
				placeholder("secret", match, () => "[segredo]");
				return typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[segredo]` : "[segredo]";
			});
		}
		out = out.replace(EMAIL, (match) => placeholder("email", match.toLowerCase(), (n) => `contato${n}@exemplo.com`));
		out = out.replace(CNPJ, (match) => placeholder("cnpj", match.replace(/\D/g, ""), (n) => `00.000.${pad(n, 3)}/0001-00`));
		out = out.replace(CPF, (match) => placeholder("cpf", match.replace(/\D/g, ""), (n) => `000.000.${pad(n, 3)}-00`));
		out = out.replace(PHONE, (match) => placeholder("phone", match.replace(/\D/g, ""), (n) => `(11) 90000-${pad(n, 4)}`));
		return out;
	};
	const deep = <T>(value: T): T => {
		if (typeof value === "string") return text(value) as T;
		if (Array.isArray(value)) return value.map((item) => deep(item)) as T;
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) as T;
		return value;
	};
	return { text, deep, counts: () => Object.fromEntries(Object.entries(maps).map(([kind, map]) => [kind, map.size])) };
}
