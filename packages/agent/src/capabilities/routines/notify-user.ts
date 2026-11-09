// `notify_user` (F9 parte 2): o push avulso do run de uma rotina marcada "só importante". O resultado da execução já fica salvo no chat sem aviso;
// só o que o dono quer saber AGORA (uma mudança, um problema, um prazo) vira push, e o servidor decide o resto: um por run, 240 caracteres, e
// nunca no horário de silêncio do dono. Só fala com o dono do run. Nas demais origens (chat, lembretes) quem avisa é a resposta ou o `agenda_result`.
import { z } from "zod";
import type { RoutinePush } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";

export const NOTIFY_USER_MAX_CHARS = 240;

export function createNotifyUserTool(push: RoutinePush) {
	return defineTool({
		name: "notify_user",
		description:
			"Send the owner a push notification about THIS routine run. The result of the run is already saved quietly in the chat; call this only if what you found is something the owner would want to know right now (a change, a problem, a deadline). " +
			"Nothing new or routine: do not call it. At most once per run, 1 or 2 short sentences in the owner's language, ready to show as the notification text. The server may refuse it (quiet hours, one per run): then stop, do not retry or rephrase.",
		inputSchema: z.object({ message: z.string().trim().min(1).max(NOTIFY_USER_MAX_CHARS).describe("The notification text, ready to show.") }),
		// Fala só com o próprio dono do run (nunca outro destinatário): não é um envio a terceiros.
		effect: "write_internal",
		async execute({ message }) {
			const result = await push.send(message);
			if (result.sent) return { ok: true, summary: "The owner was notified. Do not call this again in this run.", receipt: { what: "Push sent to the owner", where: "Notifications" } };
			if (result.reason === "one_per_run") return { ok: false, error: "A notification was already sent in this run.", hint: "Do not send another." };
			return { ok: false, error: "It is the owner's quiet hours, so nothing was sent; the result stays in the chat.", hint: "Do not retry or rephrase." };
		},
	});
}
