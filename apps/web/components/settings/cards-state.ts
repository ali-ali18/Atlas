/**
 * Estado puro do formulário de cartão (Configurações › Cofre › Cartões de compra). Sem React nem rede.
 * REGRA DO DONO: não existe CVV aqui. O código de segurança é digitado a cada compra, no cartão de aprovação.
 */
import { luhnValid, normalizeCardNumber, type SavedCardInput } from "@workspace/shared";

export type CardForm = {
	number: string;
	holder: string;
	/** "MM/AA" como o dono digita. */
	expiry: string;
	label: string;
	line1: string;
	line2: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
};

export type CardErrorKey = "payments.cards.errorNumber" | "payments.cards.errorExpiry" | "payments.cards.errorHolder" | "payments.cards.errorBilling";
export type CardFormErrors = Partial<Record<"number" | "holder" | "expiry" | "billing", CardErrorKey>>;

export const emptyCardForm = (country = "BR"): CardForm => ({ number: "", holder: "", expiry: "", label: "", line1: "", line2: "", city: "", state: "", postalCode: "", country });

const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** "1226" → "12/26": coloca a barra sozinho e aceita só dígitos. */
export function formatExpiryInput(raw: string): string {
	const digits = [...raw].filter(isDigit).join("").slice(0, 4);
	return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

/** Agrupa o número de 4 em 4 enquanto o dono digita (só dígitos, até 19). */
export function formatCardNumberInput(raw: string): string {
	const digits = [...raw].filter(isDigit).join("").slice(0, 19);
	return digits.match(/.{1,4}/g)?.join(" ") ?? "";
}

/** "MM/AA" → { month, year } ou `null` (formato errado). */
export function parseExpiry(value: string): { month: number; year: number } | null {
	const [mm, yy, ...rest] = value.split("/");
	if (rest.length > 0 || !mm || !yy || mm.length !== 2 || yy.length !== 2 || ![...mm, ...yy].every(isDigit)) return null;
	const month = Number(mm);
	return month >= 1 && month <= 12 ? { month, year: 2000 + Number(yy) } : null;
}

export function validateCardForm(form: CardForm, now: Date): { ok: true; input: SavedCardInput } | { ok: false; errors: CardFormErrors } {
	const errors: CardFormErrors = {};
	const number = normalizeCardNumber(form.number);
	if (number.length < 12 || number.length > 19 || !luhnValid(number)) errors.number = "payments.cards.errorNumber";
	if (form.holder.trim().length < 2) errors.holder = "payments.cards.errorHolder";
	const expiry = parseExpiry(form.expiry);
	// Vale até o fim do mês informado.
	if (!expiry || Date.UTC(expiry.year, expiry.month, 1) <= now.getTime()) errors.expiry = "payments.cards.errorExpiry";
	if (form.line1.trim().length < 2 || form.city.trim().length < 2 || form.state.trim().length < 2 || form.postalCode.trim().length < 3 || form.country.trim().length !== 2) errors.billing = "payments.cards.errorBilling";
	if (Object.keys(errors).length > 0 || !expiry) return { ok: false, errors };
	return {
		ok: true,
		input: {
			...(form.label.trim() && { label: form.label.trim() }),
			number,
			holder: form.holder.trim(),
			expMonth: expiry.month,
			expYear: expiry.year,
			billing: { line1: form.line1.trim(), ...(form.line2.trim() && { line2: form.line2.trim() }), city: form.city.trim(), state: form.state.trim(), postalCode: form.postalCode.trim(), country: form.country.trim().toUpperCase() },
		},
	};
}
