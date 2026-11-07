// Cartão de pagamento salvo (F6.2): validação e máscara. Funções puras, sem I/O.
// REGRA DO DONO (05/11): o CVV NUNCA é guardado. Não existe campo de CVV em nenhum tipo de "cartão salvo":
// ele só passa pelo canal efêmero da aprovação (`isValidCvv` valida o formato e mais nada).
import { z } from "zod";

export const CARD_BRANDS = ["visa", "mastercard", "amex", "elo", "hipercard", "diners", "discover", "unknown"] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

/** Tira espaços e hífens que o dono costuma digitar. */
export function normalizeCardNumber(raw: string): string {
	return raw.split(" ").join("").split("-").join("");
}

const isDigits = (value: string): boolean => value.length > 0 && [...value].every((ch) => ch >= "0" && ch <= "9");

/** Algoritmo de Luhn sobre o número só com dígitos. */
export function luhnValid(digits: string): boolean {
	if (!isDigits(digits)) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let n = digits.charCodeAt(i) - 48;
		if (double) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		double = !double;
	}
	return sum % 10 === 0;
}

const inRange = (value: number, lo: number, hi: number) => value >= lo && value <= hi;

/** Bandeira pelo prefixo (BIN). Só para o rótulo; a loja é quem manda na cobrança. */
export function detectCardBrand(digits: string): CardBrand {
	const p = (n: number) => Number(digits.slice(0, n));
	if (digits.startsWith("4")) {
		// Elo tem faixas dentro do 4 (ex.: 4011, 4312, 4389, 4514, 4576).
		if ([4011, 4312, 4389, 4514, 4576].includes(p(4))) return "elo";
		return "visa";
	}
	if (inRange(p(2), 51, 55) || inRange(p(4), 2221, 2720)) return "mastercard";
	if (digits.startsWith("34") || digits.startsWith("37")) return "amex";
	if ([5067, 4573, 6362, 6363, 5090, 6277, 6504, 6505, 6516].includes(p(4)) || inRange(p(6), 506699, 506778) || inRange(p(6), 509000, 509999)) return "elo";
	if (digits.startsWith("606282") || digits.startsWith("3841")) return "hipercard";
	if (digits.startsWith("36") || digits.startsWith("38") || digits.startsWith("30")) return "diners";
	if (digits.startsWith("6011") || digits.startsWith("65")) return "discover";
	return "unknown";
}

export const CARD_BRAND_LABELS: Readonly<Record<CardBrand, string>> = {
	visa: "Visa",
	mastercard: "Mastercard",
	amex: "American Express",
	elo: "Elo",
	hipercard: "Hipercard",
	diners: "Diners",
	discover: "Discover",
	unknown: "Cartão",
};

/** Validade vale até o ÚLTIMO dia do mês informado. */
export function cardExpiryValid(month: number, year: number, now: Date): boolean {
	if (!Number.isInteger(month) || !Number.isInteger(year) || !inRange(month, 1, 12)) return false;
	const fullYear = year < 100 ? 2000 + year : year;
	if (fullYear > now.getUTCFullYear() + 25) return false;
	const endOfMonth = Date.UTC(fullYear, month, 1);
	return endOfMonth > now.getTime();
}

/** 3 dígitos (4 no Amex). Só formato: o valor nunca é guardado. */
export function isValidCvv(value: unknown): value is string {
	return typeof value === "string" && (value.length === 3 || value.length === 4) && isDigits(value);
}

export const billingAddressSchema = z.strictObject({
	line1: z.string().trim().min(2).max(200),
	line2: z.string().trim().max(200).optional(),
	city: z.string().trim().min(2).max(100),
	state: z.string().trim().min(2).max(100),
	postalCode: z.string().trim().min(3).max(20),
	country: z.string().trim().min(2).max(2),
});
export type BillingAddress = z.infer<typeof billingAddressSchema>;

/** Corpo para salvar um cartão. NÃO tem campo de CVV: campo desconhecido (inclusive `cvv`/`cvc`) é erro. */
export const savedCardInputSchema = z.strictObject({
	label: z.string().trim().max(60).optional(),
	number: z.string().min(12).max(30),
	holder: z.string().trim().min(2).max(100),
	expMonth: z.number().int().min(1).max(12),
	expYear: z.number().int().min(0).max(2999),
	billing: billingAddressSchema,
});
export type SavedCardInput = z.infer<typeof savedCardInputSchema>;

export type SavedCardSecrets = { number: string; holder: string; expMonth: number; expYear: number; billing: BillingAddress };

export type ValidatedCard = { secrets: SavedCardSecrets; brand: CardBrand; last4: string; label: string };

export type CardValidation = { ok: true; card: ValidatedCard } | { ok: false; error: string };

/** Valida o corpo inteiro (formato, Luhn, validade futura) e devolve o que vai ao cofre mais os dados públicos. */
export function validateSavedCardInput(raw: unknown, now: Date): CardValidation {
	const parsed = savedCardInputSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, error: "Dados do cartão inválidos." };
	const input = parsed.data;
	const number = normalizeCardNumber(input.number);
	if (number.length < 12 || number.length > 19 || !luhnValid(number)) return { ok: false, error: "Número do cartão inválido." };
	if (!cardExpiryValid(input.expMonth, input.expYear, now)) return { ok: false, error: "Validade do cartão vencida ou inválida." };
	const brand = detectCardBrand(number);
	const last4 = number.slice(-4);
	const expYear = input.expYear < 100 ? 2000 + input.expYear : input.expYear;
	const label = input.label && input.label.length > 0 ? input.label : `${CARD_BRAND_LABELS[brand]} final ${last4}`;
	return { ok: true, card: { secrets: { number, holder: input.holder, expMonth: input.expMonth, expYear, billing: { ...input.billing, country: input.billing.country.toUpperCase() } }, brand, last4, label } };
}

/** Visão pública de um cartão salvo: nunca número, nome, validade nem endereço. */
export type SavedCardView = { id: string; label: string; brand: CardBrand; last4: string; createdAt: string };

/** Máscara para texto ao dono ("Visa final 1111"). */
export function cardDisplayName(brand: CardBrand, last4: string): string {
	return `${CARD_BRAND_LABELS[brand]} final ${last4}`;
}

/** Mandato de compra (F6.4): corpo da API. Valor em unidade da moeda; prazo em ISO. */
export const purchaseMandateInputSchema = z.strictObject({
	maxAmount: z.number().positive().max(1_000_000),
	currency: z.string().trim().length(3),
	merchants: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
	until: z.string().max(40),
	uses: z.number().int().min(1).max(100),
});
export type PurchaseMandateInput = z.infer<typeof purchaseMandateInputSchema>;
