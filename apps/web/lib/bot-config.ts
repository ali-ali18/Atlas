import type { BotLanguageSetting, UpdateBotInput } from "@workspace/shared";

import { DEFAULT_BOT_LANGUAGE } from "./bot-language";

/**
 * Lógica pura da Config do bot (3ª coluna). Fechar a Config só salva: o diff
 * entre o snapshot de abertura e o estado atual vira um PATCH, nunca um run do
 * agente (o agente usa a config nova na próxima mensagem do usuário).
 */

/** Campos do agente que a Config edita (estrutural: não depende do tipo de UI). */
export type ConfigSource = {
	name: string;
	snippet: string;
	description?: string | null;
	openRouterModel?: string | null;
	language?: BotLanguageSetting | null;
	color: string;
	shape?: string | null;
	policyJson?: unknown;
};

/** Snapshot da Config: só campos semânticos entram no diff do fechamento. */
export type ConfigSnapshot = {
	name: string;
	snippet: string;
	description: string;
	openRouterModel: string;
	language: string;
	color: string;
	shape: string | null;
	policyJson: unknown;
};

export const CONFIG_CLOSE_ALLOWLIST = [
	"name",
	"snippet",
	"description",
	"openRouterModel",
	"language",
	"policyJson",
	"color",
	"shape",
] as const;

export type ConfigCloseKey = (typeof CONFIG_CLOSE_ALLOWLIST)[number];

export function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function toConfigSnapshot(agent: ConfigSource): ConfigSnapshot {
	return {
		name: agent.name,
		snippet: agent.snippet,
		description: agent.description ?? "",
		openRouterModel: agent.openRouterModel ?? "",
		language: agent.language ?? DEFAULT_BOT_LANGUAGE,
		color: agent.color,
		shape: agent.shape ?? null,
		policyJson: agent.policyJson ?? null,
	};
}

export function diffConfigSnapshots(
	before: ConfigSnapshot,
	after: ConfigSnapshot,
): ConfigCloseKey[] {
	return CONFIG_CLOSE_ALLOWLIST.filter((key) =>
		key === "policyJson"
			? stableStringify(before[key]) !== stableStringify(after[key])
			: before[key] !== after[key],
	);
}

export function buildConfigPatch(
	changedKeys: readonly ConfigCloseKey[],
	current: ConfigSource,
): UpdateBotInput {
	const patch: UpdateBotInput = {};
	if (changedKeys.includes("name")) patch.name = current.name;
	if (changedKeys.includes("snippet")) patch.snippet = current.snippet;
	if (changedKeys.includes("color")) patch.color = current.color;
	if (changedKeys.includes("shape")) patch.shape = current.shape ?? undefined;
	if (changedKeys.includes("description")) {
		patch.description =
			current.description && current.description.length > 0
				? current.description
				: null;
	}
	if (changedKeys.includes("openRouterModel")) {
		const model = current.openRouterModel?.trim();
		patch.openRouterModel = model ? model : null;
	}
	if (changedKeys.includes("language")) {
		patch.language = current.language ?? DEFAULT_BOT_LANGUAGE;
	}
	if (changedKeys.includes("policyJson")) {
		patch.policyJson = (current.policyJson ??
			null) as UpdateBotInput["policyJson"];
	}
	return patch;
}

/**
 * Decide o que o fechamento da Config faz: `null` = nada a salvar (0 chamadas);
 * senão só o PATCH. Intencionalmente não existe "run" aqui.
 */
export function planConfigClose(
	before: ConfigSnapshot,
	current: ConfigSource,
): { changedKeys: ConfigCloseKey[]; patch: UpdateBotInput } | null {
	const changedKeys = diffConfigSnapshots(before, toConfigSnapshot(current));
	if (changedKeys.length === 0) return null;
	const patch = buildConfigPatch(changedKeys, current);
	if (Object.keys(patch).length === 0) return null;
	return { changedKeys, patch };
}

/** Modelo escolhido é o que já está salvo? Evita PATCH vazio e evento duplicado. */
export function isSameModelChoice(
	current: string | null | undefined,
	next: string,
): boolean {
	return (current ?? "").trim() === next.trim();
}

/**
 * Decide o que persistir quando o composer troca o modelo do bot. Vazio = "Automático" e
 * também é uma escolha: vai ao servidor como `null` (limpa o modelo fixo). Sem isso o
 * bot voltava ao último modelo concreto ao reabrir. Devolve `null` se nada mudou.
 */
export function planModelPersist(
	current: string | null | undefined,
	next: string,
): { model: string; apiValue: string | null } | null {
	const model = next.trim();
	if (isSameModelChoice(current, model)) return null;
	return { model, apiValue: model || null };
}

/**
 * Realinha o `before` do snapshot ao modelo recém-persistido, para o fechamento
 * não reenviar o mesmo diff. Outro bot ou sem snapshot: devolve o mesmo objeto.
 */
export function realignSnapshotModel<
	S extends { botId: string; before: ConfigSnapshot } | null,
>(snapshot: S, botId: string, model: string): S {
	if (!snapshot || snapshot.botId !== botId) return snapshot;
	return {
		...snapshot,
		before: { ...snapshot.before, openRouterModel: model.trim() },
	};
}
