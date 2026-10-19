import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
	CONNECTOR_GUIDE_MAX_CHARS,
	CONNECTOR_GUIDE_MAX_SUGGESTIONS,
	CONNECTOR_GUIDE_SUGGESTION_MAX_CHARS,
	appendGuideBullet,
	resolveGuideStatus,
	sanitizeGuideText,
	type ConnectorGuideSource,
	type ConnectorGuideSuggestion,
	type ConnectorGuideView,
	type ConnectorKind,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/** Colunas do guia, comuns a `McpConnection` e `ApiConnection`. */
export type GuideColumns = {
	guideMd: string | null;
	guideSource: string | null;
	guideUpdatedAt: Date | null;
	guideSuggestionsJson: Prisma.JsonValue | null;
	guideStatus?: string | null;
	guideError?: string | null;
	guideRequestedAt?: Date | null;
};

function parseSuggestions(raw: Prisma.JsonValue | null): ConnectorGuideSuggestion[] {
	if (!Array.isArray(raw)) return [];
	const out: ConnectorGuideSuggestion[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const row = item as Record<string, unknown>;
		if (typeof row.id !== "string" || typeof row.text !== "string" || !row.text.trim()) continue;
		out.push({
			id: row.id,
			text: row.text.slice(0, CONNECTOR_GUIDE_SUGGESTION_MAX_CHARS),
			createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
		});
	}
	return out;
}

/** Linha do banco → guia da UI/runtime. Sem texto e sem sugestões = null. */
export function guideFromRow(row: GuideColumns): ConnectorGuideView | null {
	const suggestions = parseSuggestions(row.guideSuggestionsJson);
	const text = (row.guideMd ?? "").slice(0, CONNECTOR_GUIDE_MAX_CHARS);
	const state = resolveGuideStatus({ status: row.guideStatus, error: row.guideError, requestedAt: row.guideRequestedAt });
	if (!text.trim() && suggestions.length === 0 && !state.status) return null;
	return {
		text,
		source: row.guideSource === "user" ? "user" : "generated",
		updatedAt: (row.guideUpdatedAt ?? new Date(0)).toISOString(),
		suggestions,
		status: state.status,
		error: state.error,
		requestedAt: row.guideRequestedAt ? row.guideRequestedAt.toISOString() : null,
	};
}

type GuideRow = GuideColumns & { id: string };
type Delegate = {
	findFirst(args: { where: Record<string, unknown> }): Promise<GuideRow | null>;
	updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};

function delegate(kind: ConnectorKind): Delegate {
	return (kind === "mcp" ? prisma.mcpConnection : prisma.apiConnection) as unknown as Delegate;
}

async function loadRow(kind: ConnectorKind, id: string, userId: string): Promise<GuideRow | null> {
	if (ownerIds(userId).length === 0) return null;
	return delegate(kind).findFirst({ where: { id, userId } });
}

/** Guia da conexão do dono; null = conexão inexistente (404) ou sem guia. */
export async function getConnectorGuide(
	kind: ConnectorKind,
	id: string,
	userId: string,
): Promise<{ found: boolean; guide: ConnectorGuideView | null }> {
	const row = await loadRow(kind, id, userId);
	return { found: Boolean(row), guide: row ? guideFromRow(row) : null };
}

/** Grava o texto do guia (geração ou edição). `generated` não atropela edição do usuário, a menos que `force`. */
export async function setConnectorGuide(
	kind: ConnectorKind,
	id: string,
	userId: string,
	input: { text: string; source: ConnectorGuideSource; force?: boolean },
): Promise<ConnectorGuideView | null> {
	const row = await loadRow(kind, id, userId);
	if (!row) return null;
	if (input.source === "generated" && row.guideSource === "user" && row.guideMd?.trim() && !input.force) {
		return guideFromRow(row);
	}
	const text = sanitizeGuideText(input.text);
	const now = new Date();
	const result = await delegate(kind).updateMany({
		where: { id, userId },
		data: { guideMd: text, guideSource: input.source, guideUpdatedAt: now, guideStatus: null, guideError: null, guideRequestedAt: null },
	});
	if (result.count !== 1) return null;
	return { text, source: input.source, updatedAt: now.toISOString(), suggestions: parseSuggestions(row.guideSuggestionsJson), status: null, error: null, requestedAt: null };
}

/** Geração pedida: a UI mostra "Gerando…" até o worker gravar o texto ou o motivo da falha. */
export async function markGuideGenerating(kind: ConnectorKind, id: string, userId: string): Promise<boolean> {
	const result = await delegate(kind).updateMany({
		where: { id, userId },
		data: { guideStatus: "generating", guideError: null, guideRequestedAt: new Date() },
	});
	return result.count === 1;
}

/** Falha visível ao usuário. `error` é texto curto em português, nunca detalhe bruto do provedor. */
export async function markGuideFailed(kind: ConnectorKind, id: string, userId: string, error: string): Promise<boolean> {
	const result = await delegate(kind).updateMany({
		where: { id, userId },
		data: { guideStatus: "failed", guideError: error.slice(0, 200) },
	});
	return result.count === 1;
}

/** Sem pendência (ex.: guia já existia e o job foi dispensado). */
export async function clearGuideStatus(kind: ConnectorKind, id: string, userId: string): Promise<boolean> {
	const result = await delegate(kind).updateMany({
		where: { id, userId },
		data: { guideStatus: null, guideError: null, guideRequestedAt: null },
	});
	return result.count === 1;
}

async function writeSuggestions(kind: ConnectorKind, id: string, userId: string, list: ConnectorGuideSuggestion[], extra: Record<string, unknown> = {}): Promise<void> {
	await delegate(kind).updateMany({
		where: { id, userId },
		data: { guideSuggestionsJson: list as unknown as Prisma.InputJsonValue, ...extra },
	});
}

/** Sugestão do bot pendente (nunca aplicada sozinha). Repetida ou acima do teto = ignorada. */
export async function addGuideSuggestion(
	kind: ConnectorKind,
	id: string,
	userId: string,
	text: string,
): Promise<ConnectorGuideSuggestion | null> {
	const row = await loadRow(kind, id, userId);
	if (!row) return null;
	const clean = text.trim().slice(0, CONNECTOR_GUIDE_SUGGESTION_MAX_CHARS);
	if (!clean) return null;
	const current = parseSuggestions(row.guideSuggestionsJson);
	const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ");
	if (current.some((item) => norm(item.text) === norm(clean))) return null;
	if ((row.guideMd ?? "").toLowerCase().includes(clean.toLowerCase())) return null;
	if (current.length >= CONNECTOR_GUIDE_MAX_SUGGESTIONS) return null;
	const suggestion = { id: randomUUID(), text: clean, createdAt: new Date().toISOString() };
	await writeSuggestions(kind, id, userId, [...current, suggestion]);
	return suggestion;
}

export type ResolveSuggestionResult =
	| { ok: true; guide: ConnectorGuideView | null }
	| { ok: false; reason: "not_found" | "suggestion_not_found" | "guide_full" };

/** Aceitar acrescenta o tópico ao guia (respeitando o limite; vira `source=user`); descartar só remove. */
export async function resolveGuideSuggestion(
	kind: ConnectorKind,
	id: string,
	userId: string,
	suggestionId: string,
	action: "accept" | "dismiss",
): Promise<ResolveSuggestionResult> {
	const row = await loadRow(kind, id, userId);
	if (!row) return { ok: false, reason: "not_found" };
	const current = parseSuggestions(row.guideSuggestionsJson);
	const picked = current.find((item) => item.id === suggestionId);
	if (!picked) return { ok: false, reason: "suggestion_not_found" };
	const rest = current.filter((item) => item.id !== suggestionId);
	if (action === "dismiss") {
		await writeSuggestions(kind, id, userId, rest);
	} else {
		const next = appendGuideBullet(row.guideMd ?? "", picked.text);
		if (!next.ok) return { ok: false, reason: "guide_full" };
		await writeSuggestions(kind, id, userId, rest, { guideMd: next.text, guideSource: "user", guideUpdatedAt: new Date() });
	}
	const fresh = await loadRow(kind, id, userId);
	return { ok: true, guide: fresh ? guideFromRow(fresh) : null };
}
