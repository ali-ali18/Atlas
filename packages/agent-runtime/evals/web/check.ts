import type { CheckResult } from "./types.js";

/** Minúsculas, sem acento, espaços colapsados: o agente responde em pt-BR, o gabarito é em inglês e ASCII. */
export function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export function mentions(text: string, needle: string): boolean {
	return normalize(text).includes(normalize(needle));
}

/** Palavra inteira (para números: "25" não casa com "125"). */
export function mentionsWord(text: string, word: string): boolean {
	const escaped = normalize(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.,-])${escaped}(?![\\w])`).test(normalize(text));
}

const MONTHS_PT = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Aceita a mesma data em ISO, dd/mm/aaaa e "3 de novembro". */
export function mentionsDate(text: string, iso: string): boolean {
	const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
	const t = normalize(text);
	const dd = String(day).padStart(2, "0");
	const mm = String(month).padStart(2, "0");
	if (t.includes(iso)) return true;
	if (t.includes(`${dd}/${mm}/${year}`) || t.includes(`${day}/${month}/${year}`)) return true;
	if (t.includes(`${dd}/${mm}`) && !t.includes("/20")) return true;
	return new RegExp(`\\b0?${day} de ${MONTHS_PT[month - 1]}\\b`).test(t);
}

/** Gabarito em forma de lista de itens: cada item achado conta; sucesso = todos achados e nenhum proibido. */
export function checkItems(input: {
	text: string;
	expected: Array<{ label: string; found: boolean }>;
	forbidden?: Array<{ label: string; found: boolean }>;
	extra?: Array<{ label: string; ok: boolean }>;
}): CheckResult {
	const missing = input.expected.filter((item) => !item.found).map((item) => `missing: ${item.label}`);
	const wrong = (input.forbidden ?? []).filter((item) => item.found).map((item) => `unexpected: ${item.label}`);
	const failedExtra = (input.extra ?? []).filter((item) => !item.ok).map((item) => `failed: ${item.label}`);
	const itemsDone = input.expected.length - missing.length;
	const details = [...missing, ...wrong, ...failedExtra];
	return {
		success: details.length === 0,
		itemsDone,
		itemsTotal: input.expected.length,
		details: details.length === 0 ? ["all expected items found"] : details,
	};
}
