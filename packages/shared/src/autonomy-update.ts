import {
	AUTONOMY_MAX_EXCEPTIONS,
	isAutonomyLevel,
	parseAutonomyPolicy,
	type AutonomyException,
	type AutonomyLevel,
	type AutonomyPolicy,
	type EffectiveAutonomy,
} from "./autonomy.js";
import { AUTONOMY_DURATIONS, autonomyUntil, type AutonomyDuration } from "./autonomy-request.js";

/**
 * Edição da política pela tela (API): body validado + política guardada
 * resultante. Pura; a rota só lê/grava.
 */

/** `level: null` = "herdar da conta" (só no bot). `exceptions` substitui a lista inteira. */
export type AutonomyUpdateInput = {
	level?: AutonomyLevel | null;
	duration?: AutonomyDuration;
	exceptions?: AutonomyException[];
};

/** Resposta de `GET/PUT /v1/autonomy` e `/v1/bots/:id/autonomy`. */
export type AutonomyView = {
	/** O que está guardado neste escopo (`null` = nada / herda). */
	stored: AutonomyPolicy | null;
	/** O que vale de fato (bot + conta + padrão). */
	effective: EffectiveAutonomy;
	source: "bot" | "account" | "default";
};

export function parseAutonomyUpdate(body: unknown): AutonomyUpdateInput | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const raw = body as Record<string, unknown>;
	const update: AutonomyUpdateInput = {};
	if ("level" in raw) {
		if (raw.level === null) update.level = null;
		else if (isAutonomyLevel(raw.level)) update.level = raw.level;
		else return null;
	}
	if ("duration" in raw) {
		if (!(AUTONOMY_DURATIONS as readonly unknown[]).includes(raw.duration)) return null;
		update.duration = raw.duration as AutonomyDuration;
	}
	if ("exceptions" in raw) {
		if (!Array.isArray(raw.exceptions) || raw.exceptions.length > AUTONOMY_MAX_EXCEPTIONS) return null;
		const parsed = parseAutonomyPolicy({ exceptions: raw.exceptions });
		if (!parsed || parsed.exceptions.length !== raw.exceptions.length) return null;
		update.exceptions = parsed.exceptions;
	}
	return update;
}

/**
 * Nível a que voltar quando a validade da mudança vencer: o nível de antes.
 * Se já havia uma validade rodando, é o fallback dela (não encadeia
 * "temporário sobre temporário").
 */
export function autonomyFallbackBase(
	current: AutonomyPolicy | null,
	levelBeforeChange: AutonomyLevel,
): AutonomyLevel {
	return current?.until && current.fallbackLevel ? current.fallbackLevel : levelBeforeChange;
}

export function applyAutonomyUpdate(input: {
	current: AutonomyPolicy | null;
	update: AutonomyUpdateInput;
	scope: "bot" | "account";
	/** Nível efetivo do escopo antes da mudança. */
	levelBeforeChange: AutonomyLevel;
	now: Date;
}): AutonomyPolicy | null {
	const { current, update } = input;
	const exceptions = update.exceptions ?? current?.exceptions ?? [];
	// `null` limpa o nível: o bot herda a conta; a conta volta ao padrão.
	const level = update.level === null ? undefined : (update.level ?? current?.level);
	const next: AutonomyPolicy = { exceptions };
	if (level) {
		next.level = level;
		if (update.duration !== undefined || level !== current?.level) {
			const until = autonomyUntil(update.duration ?? "forever", input.now);
			if (until) {
				next.until = until;
				next.fallbackLevel = autonomyFallbackBase(current, input.levelBeforeChange);
			}
		} else if (current?.until) {
			next.until = current.until;
			if (current.fallbackLevel) next.fallbackLevel = current.fallbackLevel;
		}
	}
	if (input.scope === "bot" && !next.level && next.exceptions.length === 0) return null;
	return next;
}

/**
 * Espelho em TypeScript da migração `autonomy` (SQL): conexão com
 * `confirmWrites = false` vira exceção `never_ask` do conector (catalogId, ou
 * slug em conector personalizado). Mantido junto do SQL para o teste travar
 * os dois.
 */
export function confirmWritesExceptions(
	connections: ReadonlyArray<{ catalogId: string | null; slug: string; confirmWrites: boolean }>,
): AutonomyException[] {
	return connections
		.filter((connection) => connection.confirmWrites === false)
		.map((connection) => ({ connector: connection.catalogId ?? connection.slug, mode: "never_ask" as const }));
}
