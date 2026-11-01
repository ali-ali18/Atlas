// Busca da home: bots (com a última mensagem de cada conversa) e seções, sempre pela sessão (`apiFetch`).
// Mesmos endpoints do web (`listBots` e `listSections` em apps/web/lib/atlas-api.ts). Não há lista de conversas
// à parte: o servidor entrega a conversa de cada bot em `bot.lastMessage`/`bot.conversationId`.
import type { Bot, Section } from "@workspace/shared";

export type HomeSnapshot = { bots: Bot[]; sections: Section[] };
export type SyncFailure = "unauthorized" | "network" | "server";
export type SyncResult = { ok: true; snapshot: HomeSnapshot } | { ok: false; reason: SyncFailure };
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function validBot(value: unknown): value is Bot {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		Array.isArray(value.memberIds) &&
		(value.lastMessage === null || value.lastMessage === undefined || (isRecord(value.lastMessage) && typeof value.lastMessage.content === "string"))
	);
}

function validSection(value: unknown): value is Section {
	return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.order === "number";
}

/** Aceita só o que a home sabe desenhar; item malformado é descartado em vez de derrubar a lista. */
export function parseSnapshot(botsBody: unknown, sectionsBody: unknown): HomeSnapshot | null {
	const rawBots = isRecord(botsBody) ? botsBody.bots : null;
	const rawSections = isRecord(sectionsBody) ? sectionsBody.sections : null;
	if (!Array.isArray(rawBots) || !Array.isArray(rawSections)) return null;
	return { bots: rawBots.filter(validBot).map((bot) => ({ ...bot, lastMessage: bot.lastMessage ?? null })), sections: rawSections.filter(validSection) };
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/** 401 em qualquer das duas chamadas = sessão que o servidor não reconhece; falha de rede não derruba a sessão. */
export async function fetchHome(apiFetch: ApiFetch, signal?: AbortSignal): Promise<SyncResult> {
	const init: RequestInit = { signal, headers: { accept: "application/json" } };
	let responses: [Response, Response];
	try {
		responses = await Promise.all([apiFetch("/v1/bots", init), apiFetch("/v1/sections", init)]);
	} catch {
		return { ok: false, reason: "network" };
	}
	if (responses.some((response) => response.status === 401)) return { ok: false, reason: "unauthorized" };
	if (responses.some((response) => !response.ok)) return { ok: false, reason: "server" };
	const [botsBody, sectionsBody] = await Promise.all(responses.map(readJson));
	const snapshot = parseSnapshot(botsBody, sectionsBody);
	return snapshot ? { ok: true, snapshot } : { ok: false, reason: "server" };
}
