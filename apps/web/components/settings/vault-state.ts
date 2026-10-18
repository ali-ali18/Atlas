import { SECRET_NAME_RE, hostOf, suggestLoginName, suggestSecretName } from "@workspace/shared";
import type { VaultAuditEntry, VaultExtraField, VaultItemKind, VaultItemView, VaultWriteInput } from "@/lib/atlas-api";

/** Estado puro do Cofre (Configurações): busca, formulário, gerador de senha e histórico. Sem React. */

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%&*?-_=+";

export type RandomInts = (max: number) => number;

const cryptoInt: RandomInts = (max) => {
	const buffer = new Uint32Array(1);
	const limit = Math.floor(0x100000000 / max) * max;
	do {
		globalThis.crypto.getRandomValues(buffer);
	} while (buffer[0]! >= limit);
	return buffer[0]! % max;
};

/** Senha forte (padrão 20): sempre tem minúscula, maiúscula, número e (opcional) símbolo. */
export function generatePassword(options: { length?: number; symbols?: boolean; random?: RandomInts } = {}): string {
	const length = Math.max(8, Math.min(64, options.length ?? 20));
	const random = options.random ?? cryptoInt;
	const pools = [LOWER, UPPER, DIGITS, ...(options.symbols === false ? [] : [SYMBOLS])];
	const all = pools.join("");
	const chars = pools.map((pool) => pool[random(pool.length)]!);
	while (chars.length < length) chars.push(all[random(all.length)]!);
	for (let i = chars.length - 1; i > 0; i -= 1) {
		const j = random(i + 1);
		[chars[i], chars[j]] = [chars[j]!, chars[i]!];
	}
	return chars.join("");
}

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: string };

export function passwordStrength(password: string): PasswordStrength {
	if (!password) return { score: 0, label: "" };
	let variety = 0;
	if (/[a-z]/.test(password)) variety += 1;
	if (/[A-Z]/.test(password)) variety += 1;
	if (/\d/.test(password)) variety += 1;
	if (/[^A-Za-z0-9]/.test(password)) variety += 1;
	let score = 0;
	if (password.length >= 8) score += 1;
	if (password.length >= 12 && variety >= 2) score += 1;
	if (password.length >= 14 && variety >= 3) score += 1;
	if (password.length >= 18 && variety >= 4) score += 1;
	const labels = ["Fraca", "Fraca", "Razoável", "Boa", "Forte"] as const;
	return { score: score as PasswordStrength["score"], label: labels[score]! };
}

function fold(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export type VaultFilter = "all" | VaultItemKind;

/** Busca sem acento em nome, rótulo, domínio, usuário e descrição. */
export function filterVaultItems(items: readonly VaultItemView[], query: string, kind: VaultFilter = "all"): VaultItemView[] {
	const terms = fold(query).split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		if (kind !== "all" && item.kind !== kind) return false;
		if (terms.length === 0) return true;
		const haystack = fold([item.name, item.label, item.domain ?? "", item.username ?? "", item.description].join(" "));
		return terms.every((term) => haystack.includes(term));
	});
}

export function itemTitle(item: Pick<VaultItemView, "label" | "name">): string {
	return item.label || item.name;
}

export function itemSubtitle(item: VaultItemView): string {
	if (item.kind === "login") return [item.username, item.domain].filter(Boolean).join(" · ") || "Login de site";
	return item.description || "Segredo";
}

// ----- formulário -----

export type VaultForm = {
	kind: VaultItemKind;
	name: string;
	/** O nome (marcador) foi mexido à mão: para de acompanhar o endereço/rótulo. */
	nameTouched: boolean;
	label: string;
	description: string;
	siteUrl: string;
	username: string;
	/** Segredo simples. */
	value: string;
	password: string;
	totp: string;
	notes: string;
	extras: VaultExtraField[];
};

export function emptyVaultForm(kind: VaultItemKind): VaultForm {
	return { kind, name: "", nameTouched: false, label: "", description: "", siteUrl: "", username: "", value: "", password: "", totp: "", notes: "", extras: [] };
}

/** Preenche o nome sugerido a partir do endereço (login) enquanto a pessoa não o editou. */
export function withSuggestedName(form: VaultForm, patch: Partial<VaultForm>): VaultForm {
	const next = { ...form, ...patch };
	if (patch.name !== undefined) next.nameTouched = true;
	if (!next.nameTouched && next.kind === "login") {
		const fromUrl = suggestLoginName(next.siteUrl);
		if (fromUrl) next.name = suggestSecretName(fromUrl);
		if (patch.siteUrl !== undefined && !next.label.trim() && fromUrl) next.label = fromUrl.charAt(0).toUpperCase() + fromUrl.slice(1);
	}
	return next;
}

export function formFromItem(item: VaultItemView): VaultForm {
	return { ...emptyVaultForm(item.kind), name: item.name, nameTouched: true, label: item.label, description: item.description, siteUrl: item.siteUrl ?? "", username: item.username ?? "" };
}

export type VaultFormErrors = Partial<Record<"name" | "siteUrl" | "value" | "password" | "extras", string>>;

export function normalizeSiteUrl(raw: string): string {
	const text = raw.trim();
	if (!text) return "";
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

export function validateVaultForm(form: VaultForm, editing: boolean): { ok: true } | { ok: false; errors: VaultFormErrors } {
	const errors: VaultFormErrors = {};
	if (!SECRET_NAME_RE.test(form.name.trim())) errors.name = "Use letras, números, - e _ (até 64), sem espaços.";
	if (form.kind === "secret" && !editing && !form.value) errors.value = "Cole o valor do segredo.";
	if (form.kind === "login") {
		if (!hostOf(normalizeSiteUrl(form.siteUrl))) errors.siteUrl = "Informe o endereço do site (ex.: github.com).";
		if (!editing && !form.password) errors.password = "Informe a senha (ou gere uma).";
		if (form.extras.some((extra) => !extra.name.trim())) errors.extras = "Todo campo extra precisa de nome.";
	}
	return Object.keys(errors).length === 0 ? { ok: true } : { ok: false, errors };
}

/** Corpo da API. Na edição, campos secretos vazios não são enviados (o valor guardado fica). */
export function formToInput(form: VaultForm, editing: boolean): VaultWriteInput {
	const base: VaultWriteInput = {
		...(editing ? {} : { kind: form.kind }),
		name: form.name.trim(),
		label: form.label.trim(),
		description: form.description.trim(),
	};
	if (form.kind === "secret") return { ...base, ...(form.value ? { value: form.value } : {}) };
	return {
		...base,
		siteUrl: normalizeSiteUrl(form.siteUrl),
		username: form.username.trim(),
		...(form.password ? { password: form.password } : {}),
		...(form.totp.trim() ? { totp: form.totp.trim() } : {}),
		...(form.notes ? { notes: form.notes } : {}),
		...(form.extras.length > 0 ? { extras: form.extras.map((extra) => ({ ...extra, name: extra.name.trim() })) } : {}),
	};
}

// ----- histórico -----

const ACTION_LABEL: Record<string, string> = {
	created: "Criado",
	updated: "Editado",
	revealed: "Revelado",
	copied: "Copiado",
	used: "Usado",
	rotated: "Trocado",
	approved: "Uso autorizado",
};

export function auditLabel(entry: Pick<VaultAuditEntry, "action" | "actor" | "botName" | "detail">): string {
	const action = ACTION_LABEL[entry.action] ?? entry.action;
	if (entry.actor === "bot") {
		const who = entry.botName ? `pelo bot ${entry.botName}` : "por um bot";
		return `${action} ${who}${entry.detail ? ` (${entry.detail})` : ""}`;
	}
	return `${action} por você${entry.detail ? ` (${entry.detail})` : ""}`;
}

export function formatVaultDate(iso: string | null, now: Date = new Date()): string {
	if (!iso) return "nunca";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	const diffMin = Math.round((now.getTime() - date.getTime()) / 60_000);
	if (diffMin < 1) return "agora";
	if (diffMin < 60) return `há ${diffMin} min`;
	const hours = Math.round(diffMin / 60);
	if (hours < 24) return `há ${hours} h`;
	const days = Math.round(hours / 24);
	if (days < 30) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
	return date.toLocaleDateString("pt-BR");
}

/** Texto do aviso quando o cofre não está pronto no servidor. */
export const VAULT_UNAVAILABLE = "O cofre precisa da chave de criptografia do servidor (CONNECTOR_ENCRYPTION_KEY).";
