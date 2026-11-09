// Marcadores `{{secret:NOME}}` nos argumentos das tools de saída (conector do dono, `code_shell`). O modelo escreve o NOME;
// o executor troca pelo valor na hora de executar, DEPOIS da aprovação e só para a tool (o cartão, o hash do journal, os
// eventos e o checkpoint seguem com o marcador). O valor sai do cofre rastreado do run (`trackVault`), então toda saída
// do run passa pela redação com ele.
//
// Só `kind: "secret"`. Senha e código de login (`{{login:...}}`) só vão à VM por `login_fill`; segredo de rotina
// (`{{secret:rotina:...}}`) é da frente de Rotinas. Cada recusa diz o que fazer, nunca o valor.
import { findSecretRefs, replaceSecretRefs, type SecretRef } from "@workspace/shared";
import type { Vault } from "../ports/vault.js";

export type SecretRefIssue = { error: string; hint: string };

function collect(value: unknown, into: SecretRef[] = []): SecretRef[] {
	if (typeof value === "string") into.push(...findSecretRefs(value));
	else if (Array.isArray(value)) for (const item of value) collect(item, into);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item, into);
	return into;
}

/** Há algum marcador nos argumentos? (barato: serve para não tocar no cofre à toa) */
export function hasSecretRefs(args: unknown): boolean {
	return collect(args).length > 0;
}

function mapStrings(value: unknown, fn: (piece: string) => string): unknown {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
	return value;
}

const SECRET_REQUEST_HINT = "If the secret is not in the vault, ask the owner with secret_request (the value goes straight to the vault, never through the chat).";

/**
 * Confere, SEM ler valor nenhum, que todo marcador é de um segredo simples que o dono tem. Roda antes da aprovação: o dono
 * nunca aprova uma chamada que já se sabe que não pode rodar.
 */
export async function checkSecretRefs(ownerId: string, vault: Pick<Vault, "listHandles">, args: unknown): Promise<SecretRefIssue | null> {
	const refs = collect(args);
	if (refs.length === 0) return null;
	const unsupported = refs.filter((ref) => ref.kind !== "secret");
	if (unsupported.length > 0) {
		return {
			error: "Only {{secret:<name>}} markers can be used here; login passwords and codes are never put into tool arguments, and routine secrets are not available.",
			hint: "To sign in to a site use login_fill (the owner approves it). Nothing was run.",
		};
	}
	const handles = await vault.listHandles(ownerId);
	const simple = new Set(handles.filter((h) => h.kind !== "login").map((h) => h.id));
	const missing = [...new Set(refs.flatMap((ref) => (ref.kind === "secret" && !simple.has(ref.name) ? [ref.name] : [])))];
	if (missing.length === 0) return null;
	return { error: `Secret not found in the vault: ${missing.join(", ")}. Nothing was run.`, hint: `${SECRET_REQUEST_HINT} Use secret_list to see the names that exist.` };
}

/** Troca os marcadores pelo valor. Valor dentro de texto que é JSON vai escapado (aspas e barras não quebram o corpo). */
export async function injectSecretRefs(ownerId: string, vault: Pick<Vault, "resolve">, args: unknown): Promise<{ ok: true; args: unknown } | ({ ok: false } & SecretRefIssue)> {
	const refs = collect(args);
	if (refs.length === 0) return { ok: true, args };
	const resolved = new Map<string, string>();
	const missing: string[] = [];
	for (const ref of refs) {
		if (ref.kind !== "secret" || resolved.has(ref.raw)) continue;
		const secret = await vault.resolve(ownerId, ref.name);
		if (secret === null) missing.push(ref.name);
		else resolved.set(ref.raw, secret.reveal());
	}
	if (missing.length > 0) return { ok: false, error: `Secret not found in the vault: ${[...new Set(missing)].join(", ")}. Nothing was run.`, hint: SECRET_REQUEST_HINT };
	const swap = (piece: string): string => {
		const lead = piece.trimStart();
		const jsonLike = lead.startsWith("{") || lead.startsWith("[");
		return replaceSecretRefs(piece, (ref) => {
			const value = resolved.get(ref.raw);
			if (value === undefined) return undefined;
			return jsonLike ? JSON.stringify(value).slice(1, -1) : value;
		});
	};
	return { ok: true, args: mapStrings(args, swap) };
}
