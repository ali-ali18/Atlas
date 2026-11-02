// `PATCH /v1/bots/:id`: o mesmo endpoint do web (`updateBot` em `apps/web/lib/atlas-api.ts`). O servidor só altera bot
// do dono da sessão (consulta por `ownerId`; bot de outro devolve 404).
import { ChatApiError } from "./chat-api";
import type { BotPatch } from "./bot-edit";
import type { ApiFetch } from "./home-sync";

/** O corpo do PATCH: só os campos permitidos, nada além. */
export function botPatchBody(patch: BotPatch): Record<string, string> {
	const body: Record<string, string> = {};
	if (patch.name !== undefined) body.name = patch.name;
	if (patch.shape !== undefined) body.shape = patch.shape;
	if (patch.color !== undefined) body.color = patch.color;
	if (patch.language !== undefined) body.language = patch.language;
	return body;
}

export async function patchBot(apiFetch: ApiFetch, botId: string, patch: BotPatch): Promise<void> {
	const body = botPatchBody(patch);
	if (Object.keys(body).length === 0) return;
	const response = await apiFetch(`/v1/bots/${encodeURIComponent(botId)}`, { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
}

/** Frase simples para o erro ao salvar (sem texto técnico). */
export function saveErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Não encontrei este bot. Ele pode ter sido apagado.";
		if (error.status === 400) return "Algum dado não foi aceito. Confira o nome e tente de novo.";
		return "Não consegui salvar agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
