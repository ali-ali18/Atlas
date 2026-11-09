// `secret_request`: pede ao dono que cadastre no cofre um segredo que falta. O dono digita o valor num campo de senha do
// cartão e ele vai direto ao cofre; o modelo nunca o vê e o valor nunca passa pela conversa. Encerra o turno: a resposta
// do dono chega depois como uma mensagem comum.
import { isValidSecretName } from "@workspace/shared";
import { z } from "zod";
import type { SecretRequests } from "../../ports/vault.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_NAMES = 5;

export function createSecretRequestTool(requests: SecretRequests) {
	return defineTool({
		name: "secret_request",
		description:
			"Ask the owner to save a secret you lack (API key, token, password) in their vault. A card with a password field is shown; the value goes straight to the vault and you never see it. This ends your turn: use the secret in a later message with {{secret:<name>}}. " +
			"Names use letters, digits, - and _ (e.g. stripe-key). Do not use it for something secret_list already shows, or to ask for a value in the chat.",
		inputSchema: z.object({
			names: z.array(z.string().refine(isValidSecretName, "use letters, digits, - and _ (up to 64), e.g. stripe-key")).min(1).max(MAX_NAMES).describe("Vault names to ask for (1 to 5), e.g. [\"stripe-key\"]."),
			reason: z.string().trim().min(1).max(300).describe("One short sentence, in the owner's language: why you need it."),
		}),
		effect: "read",
		endsTurn: true,
		async execute({ names, reason }, ctx) {
			const unique = [...new Set(names)];
			const handles = await ctx.ports.vault.listHandles(ctx.ownerId);
			// Login (usuário e senha de um site) não é segredo simples: `{{secret:x}}` não o alcança, quem o usa é `login_fill`.
			const logins = unique.filter((name) => handles.some((h) => h.id === name && h.kind === "login"));
			if (logins.length > 0) return { ok: false, error: `"${logins.join(", ")}" is a saved site login, not a simple secret.`, hint: "Sign in with login_fill (the owner approves it); {{secret:<name>}} does not work for logins. Pick another name if you need a separate API key or token." };
			const existing = new Set(handles.filter((h) => h.kind !== "login").map((h) => h.id));
			const missing = unique.filter((name) => !existing.has(name));
			if (missing.length === 0) return { ok: true, summary: `Already in the vault: ${unique.join(", ")}. Use ${unique.map((name) => `{{secret:${name}}}`).join(", ")}; nothing was asked of the owner.` };
			await requests.ask(ctx.ownerId, ctx.runId, { names: missing, reason });
			return { ok: true, summary: `A card asked the owner to save ${missing.join(", ")} (the value goes straight to the vault). Your turn ends here; afterwards use ${missing.map((name) => `{{secret:${name}}}`).join(", ")}. Do not ask for the value in the chat.` };
		},
	});
}
