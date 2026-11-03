// `PATCH /v1/bots/:id` e `POST /v1/bots`: os mesmos endpoints do web (`updateBot` em `apps/web/lib/atlas-api.ts`). O
// servidor só altera bot do dono da sessão (consulta por `ownerId`; bot de outro devolve 404).
import type { Bot } from "@workspace/shared";
import { ChatApiError } from "./chat-api";
import type { BotPatch } from "./bot-edit";
import { toHomeBot } from "./home-list";
import type { ApiFetch } from "./home-sync";
import type { HomeBot } from "./home-types";
import type { NewBotBody } from "./new-bot";

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * `POST /v1/bots` (o mesmo do web): cria o bot e devolve como a home o desenha (mapper `toHomeBot`, o mesmo da lista).
 * O corpo vem de `buildNewBotBody` (só nome, forma e cor). O servidor responde 201 com o bot e a conversa dele.
 */
export async function createBot(apiFetch: ApiFetch, body: NewBotBody): Promise<HomeBot> {
	const response = await apiFetch("/v1/bots", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	let data: unknown = null;
	try {
		data = await response.json();
	} catch {
		// corpo sem JSON: tratado abaixo como resposta inesperada
	}
	if (!isRecord(data) || typeof data.id !== "string" || typeof data.name !== "string" || !Array.isArray(data.memberIds)) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return toHomeBot({ ...(data as unknown as Bot), lastMessage: null });
}

/** Frase simples para o erro ao criar (sem texto técnico). */
export function createErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 400) return "Algum dado não foi aceito. Confira o nome e tente de novo.";
		return "Não consegui criar o bot agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
