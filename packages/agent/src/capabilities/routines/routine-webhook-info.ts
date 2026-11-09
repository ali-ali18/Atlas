// `routine_webhook_info`: os webhooks das rotinas do dono (neste bot): o endereço público SEM segredo e o cabeçalho que o outro sistema
// manda. O segredo nunca aparece aqui (nem para o modelo, nem em cartão): o dono o copia da própria rotina na Biblioteca ("Gerar novo
// segredo" mostra o novo uma vez só). Leitura privada.
import { z } from "zod";
import type { Routines } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";

export const ROUTINE_WEBHOOK_HEADER = "X-Atlas-Hook-Secret";

export function createRoutineWebhookInfoTool(routines: Routines) {
	return defineTool({
		name: "routine_webhook_info",
		description:
			"List the owner's routines that start from a webhook: the public address (POST, JSON body) and the header the other system must send. The secret is NEVER shown to you: the owner copies it from the routine in the Library (the 'Gerar novo segredo' button shows a new one once). " +
			"Use it when the owner wants to wire another system (n8n, Zapier, a form) to a routine and needs the address. Do not use it to create a webhook (routine_create with triggerType webhook), and never invent or ask for a secret in the chat.",
		inputSchema: z.object({}),
		effect: "read",
		privateData: true,
		async execute(_args, ctx) {
			const hooks = await routines.webhooks(ctx.ownerId);
			if (hooks.length === 0) return { ok: true, summary: "No routine with a webhook in this bot. Create one with routine_create (triggerType webhook), then call this again." };
			const lines = hooks.map((hook) => `- "${hook.name}" (${hook.enabled ? "active" : "paused"}): POST ${hook.url}`);
			return {
				ok: true,
				summary: `Webhooks of the owner's routines (secret not shown):\n${lines.join("\n")}\nThe other system sends the header ${ROUTINE_WEBHOOK_HEADER} with the routine's secret. You do not have it: tell the owner to copy it from the routine in the Library.`,
			};
		},
	});
}
