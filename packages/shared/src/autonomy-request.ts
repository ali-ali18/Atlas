import {
	AUTONOMY_LEVELS,
	AUTONOMY_MAX_EXCEPTIONS,
	isAutonomyLevel,
	upsertAutonomyException,
	type AutonomyException,
	type AutonomyLevel,
	type AutonomyPolicy,
} from "./autonomy.js";
import { normalizedLower } from "./skill-extract.js";

/**
 * `set_autonomy` por conversa (F10). A tool só existe quando a ÚLTIMA fala
 * do usuário pede isso, com as palavras dele. Conteúdo externo (resultado de
 * tool, e-mail, página) nunca conta: o caller passa só a fala do usuário e
 * `userAuthoredText` corta o que o sistema anexa depois dela.
 */

/** Marcadores que o sistema acrescenta à fala do usuário (resultado de ação confirmada). */
const SYSTEM_APPENDED_MARKERS = ["[Ação confirmada", "<<<"];

/** A parte da mensagem escrita pelo usuário, sem resultado de ação anexado. */
export function userAuthoredText(text: string): string {
	let end = text.length;
	for (const marker of SYSTEM_APPENDED_MARKERS) {
		const index = text.indexOf(marker);
		if (index >= 0 && index < end) end = index;
	}
	return text.slice(0, end).trim();
}

const REQUEST_MAX_CHARS = 400;

const AUTONOMY_PATTERNS: RegExp[] = [
	// "pode fazer sem (me) perguntar", "faz sem me perguntar", "sem pedir confirmacao"
	/\bsem (me )?(perguntar|pedir (confirmacao|autorizacao|permissao|aprovacao)|confirmacao|autorizacao)\b/,
	// "nao precisa (me) perguntar/pedir", "nao (me) pergunte", "nao peca confirmacao"
	/\bnao (precisa|preciso|tem (que|de)|vai precisar) (me )?(perguntar|pedir|confirmar)\b/,
	/\bnao (me )?(pergunte|peca|pergunta)\b/,
	/\b(para|pare|chega) de (me )?(perguntar|pedir (confirmacao|autorizacao|permissao))\b/,
	// "seja autonomo", "modo autonomo", "autonomia total"
	/\b(seja|ser|fique|ficar|modo|fica|quero (voce |vc )?(mais )?)\s*(mais )?autonom[oa]\b/,
	/\bautonomia\b[^.!?\n]{0,30}\b(total|maxima|minima|maior|menor|baixa|alta)\b/,
	/\b(muda|mude|altere|alterar|troque|trocar|coloque|coloca|ative|ativa|defina|define|configure|configura|ajuste|ajusta)\b[^.!?\n]{0,30}\bautonomia\b/,
	// "sempre pergunte antes", "volta a perguntar", "pede confirmacao de tudo"
	/\bsempre (me )?(pergunte|pergunta|peca|pede) (antes|confirmacao)\b/,
	/\b(volta|voltar|volte) a (me )?(perguntar|pedir)\b/,
	/\b(pergunte|pergunta|peca|pede) (antes de|confirmacao (de|para)) (tudo|qualquer|agir|executar|alterar)\b/,
];

/** Pedido explícito de mudar quanto o agente age sozinho. */
export function looksLikeAutonomyRequest(text: string): boolean {
	const authored = userAuthoredText(text);
	if (!authored || authored.length > REQUEST_MAX_CHARS) return false;
	const n = normalizedLower(authored);
	return AUTONOMY_PATTERNS.some((pattern) => pattern.test(n));
}

export const AUTONOMY_DURATIONS = ["1d", "7d", "30d", "forever"] as const;
export type AutonomyDuration = (typeof AUTONOMY_DURATIONS)[number];

export const AUTONOMY_DURATION_LABELS: Record<AutonomyDuration, string> = {
	forever: "Sempre",
	"1d": "1 dia",
	"7d": "7 dias",
	"30d": "30 dias",
};

const DURATION_MS: Record<Exclude<AutonomyDuration, "forever">, number> = {
	"1d": 86_400_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
};

export function autonomyUntil(duration: AutonomyDuration, now: Date): string | undefined {
	if (duration === "forever") return undefined;
	return new Date(now.getTime() + DURATION_MS[duration]).toISOString();
}

export type SetAutonomyInput = {
	scope: "bot" | "account";
	level: AutonomyLevel;
	duration: AutonomyDuration;
	/** Só restritivas (`always_ask`, `blocked`): afrouxar exceção é decisão da tela. */
	exceptions: AutonomyException[];
};

/** Valida os args do modelo; lança em pt-BR (vira `tool_result` de erro acionável). */
export function parseSetAutonomyArgs(args: Record<string, unknown>): SetAutonomyInput {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		throw new Error("informe scope e level");
	}
	const scope = args.scope === "account" ? "account" : args.scope === "bot" ? "bot" : null;
	if (!scope) throw new Error('scope deve ser "bot" ou "account"');
	if (!isAutonomyLevel(args.level)) {
		throw new Error(`level deve ser um de: ${AUTONOMY_LEVELS.join(", ")}`);
	}
	const duration = args.duration ?? "forever";
	if (!(AUTONOMY_DURATIONS as readonly unknown[]).includes(duration)) {
		throw new Error(`duration deve ser um de: ${AUTONOMY_DURATIONS.join(", ")}`);
	}
	const exceptions: AutonomyException[] = [];
	if (Array.isArray(args.exceptions)) {
		for (const item of args.exceptions.slice(0, AUTONOMY_MAX_EXCEPTIONS)) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const entry = item as Record<string, unknown>;
			if (entry.mode !== "always_ask" && entry.mode !== "blocked") continue;
			const tool = typeof entry.tool === "string" ? entry.tool.trim().slice(0, 120) : "";
			const connector = typeof entry.connector === "string" ? entry.connector.trim().slice(0, 120) : "";
			if (!tool && !connector) continue;
			exceptions.push({ ...(tool ? { tool } : { connector }), mode: entry.mode });
		}
	}
	return { scope, level: args.level, duration: duration as AutonomyDuration, exceptions };
}

/**
 * Próxima política guardada do escopo. `previousLevel` é o nível efetivo do
 * escopo antes da mudança: vira o `fallbackLevel` quando há validade.
 */
export function applySetAutonomy(input: {
	current: AutonomyPolicy | null;
	request: SetAutonomyInput;
	previousLevel: AutonomyLevel;
	now: Date;
}): AutonomyPolicy {
	const until = autonomyUntil(input.request.duration, input.now);
	let exceptions = input.current?.exceptions ?? [];
	for (const next of input.request.exceptions) {
		exceptions = upsertAutonomyException(exceptions, next);
	}
	return {
		level: input.request.level,
		...(until ? { until, fallbackLevel: input.previousLevel } : {}),
		exceptions: exceptions.slice(0, AUTONOMY_MAX_EXCEPTIONS),
	};
}
