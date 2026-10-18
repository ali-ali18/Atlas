import { normalizeAccountLabel } from "@workspace/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jwtClaims(idToken: unknown): Record<string, unknown> | null {
	if (typeof idToken !== "string") return null;
	const part = idToken.split(".")[1];
	if (!part) return null;
	try {
		return asRecord(JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")));
	} catch {
		return null;
	}
}

/**
 * Identidade da conta (e-mail ou nome) quando o provedor a expõe na resposta do token
 * (`id_token` OIDC, `email`, `user.email`, `owner.user.person.email`, `workspace_name`).
 * Sem nenhuma pista, devolve `null` e o chamador mantém o apelido padrão ("Conta 2").
 */
export function accountLabelFromTokens(tokens: unknown): string | null {
	const root = asRecord(tokens);
	if (!root) return null;
	const claims = jwtClaims(root.id_token);
	const owner = asRecord(asRecord(asRecord(root.owner)?.user)?.person);
	const candidates = [
		str(claims?.email),
		str(claims?.preferred_username),
		str(claims?.name),
		str(root.email),
		str(asRecord(root.user)?.email),
		str(owner?.email),
		str(root.workspace_name),
	];
	for (const candidate of candidates) {
		const label = candidate ? normalizeAccountLabel(candidate) : null;
		if (label) return label;
	}
	return null;
}

/** Apelido automático ("Conta 2") que a identidade real pode substituir; apelido digitado pelo usuário nunca é trocado. */
export function isAutoAccountLabel(label: string | null | undefined): boolean {
	return !label || /^Conta \d+$/.test(label);
}
