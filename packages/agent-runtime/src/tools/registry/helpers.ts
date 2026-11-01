import type { ToolContext } from "./types.js";

export function truncateSnippet(content: string, max = 300): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export const BOT_CONFIG_EVENT_MARKERS = [
	"[bot-created]",
	"[bot-config]",
	"[questionnaire-submitted]",
	"questionnaire-submitted",
	"bot-created",
];

// `config-closed` saiu da lista de propósito: fechar a Config só salva e nunca
// inicia run do agente (C1), então o texto não deve ser tratado como evento.

/** Detecta evento proativo de bot pelo objective/messages (case-insensitive). */
export function isBotConfigEventObjective(objective: string): boolean {
	const lower = (objective ?? "").toLowerCase();
	return BOT_CONFIG_EVENT_MARKERS.some((marker) => lower.includes(marker));
}

/** F4 — aceita array ou string JSON que parseia para array. */
export function asArrayLoose(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value.trim()) {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// Cai nas validações abaixo (items vazio / item inválido).
		}
	}
	return [];
}

/** Escopo do bot do run (usuário + bot). Sem bot vinculado, tools de rotina não operam. */
export function skillScope(ctx: ToolContext): { userId: string; botId: string } | null {
	if (!ctx.botId) return null;
	return { userId: ctx.userId ?? "default", botId: ctx.botId };
}
