// Catálogo de bots no servidor: os mesmos endpoints do web (`getCatalog`, `getCatalogBot`, `installCatalogBot` em
// `apps/web/lib/atlas-api.ts`), sempre por `apiFetch`. O servidor decide o dono pela sessão; o app só manda o slug.
import { type CatalogBot, type CatalogDetail, parseCatalog, parseCatalogDetail } from "./catalog";
import { ChatApiError, isUnauthorized, json } from "./chat-api";
import type { ApiFetch } from "./home-sync";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function fetchCatalog(apiFetch: ApiFetch): Promise<CatalogBot[]> {
	const bots = parseCatalog(await json<unknown>(apiFetch, "/v1/catalog"));
	if (!bots) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return bots;
}

export async function fetchCatalogBot(apiFetch: ApiFetch, slug: string): Promise<CatalogDetail> {
	const detail = parseCatalogDetail(await json<unknown>(apiFetch, `/v1/catalog/bots/${encodeURIComponent(slug)}`));
	if (!detail) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	return detail;
}

/** id do modelo -> nome de exibição (`GET /v1/models`). Só enfeita a tela: qualquer falha dá mapa vazio. */
export async function fetchModelNames(apiFetch: ApiFetch): Promise<Record<string, string>> {
	try {
		const body = await json<unknown>(apiFetch, "/v1/models");
		const names: Record<string, string> = {};
		for (const model of isRecord(body) && Array.isArray(body.models) ? body.models : []) {
			if (isRecord(model) && typeof model.id === "string" && typeof model.name === "string" && model.name.trim()) names[model.id] = model.name.trim();
		}
		return names;
	} catch {
		return {};
	}
}

/** O corpo do install: só os campos que o servidor aceita (cor e forma ficam as do modelo). */
export type CatalogInstallBody = { name: string; useSuggestedModel: boolean; routines: number[] };
export type CatalogInstallResult = { botId: string; name: string; installedSkills: string[]; routines: { name: string; prompt: string; cron: string }[]; warnings: string[] };

/** `POST /v1/catalog/bots/:slug/install`: cria o bot, instala as habilidades e posta a primeira mensagem. As rotinas só voltam como lista (quem chama as cria). */
export async function installCatalogBot(apiFetch: ApiFetch, slug: string, body: CatalogInstallBody): Promise<CatalogInstallResult> {
	const data = await json<unknown>(apiFetch, `/v1/catalog/bots/${encodeURIComponent(slug)}/install`, { method: "POST", body: JSON.stringify(body) });
	if (!isRecord(data) || typeof data.botId !== "string" || !data.botId) throw new ChatApiError("Resposta inesperada do servidor.", 502);
	const routines: CatalogInstallResult["routines"] = [];
	for (const item of Array.isArray(data.routines) ? data.routines : []) {
		if (isRecord(item) && typeof item.name === "string" && typeof item.prompt === "string" && typeof item.cron === "string") routines.push({ name: item.name, prompt: item.prompt, cron: item.cron });
	}
	return {
		botId: data.botId,
		name: typeof data.name === "string" ? data.name : "",
		installedSkills: Array.isArray(data.installedSkills) ? data.installedSkills.filter((item): item is string => typeof item === "string") : [],
		routines,
		warnings: Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === "string") : [],
	};
}

/** Frase simples para o erro (sem texto técnico nem o texto cru do servidor). `action`: o que se tentava fazer. */
export function catalogErrorText(error: unknown, action: "list" | "detail" | "install"): string {
	if (error instanceof ChatApiError) {
		if (isUnauthorized(error)) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return action === "detail" ? "Não encontrei este bot no catálogo." : "Não encontrei este bot. Ele pode ter saído do catálogo.";
		if (action === "install") {
			if (error.status === 422) return "O conteúdo deste bot foi bloqueado pela varredura de segurança. Ele não foi instalado.";
			if (error.status === 400) return "O nome deve ter de 1 a 40 caracteres.";
			return "Não consegui instalar o bot agora. Tente de novo.";
		}
		return action === "list" ? "Não consegui carregar o catálogo agora. Tente de novo em instantes." : "Não consegui abrir este bot agora. Tente de novo em instantes.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
