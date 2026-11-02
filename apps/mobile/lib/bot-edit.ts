// Editar bot: validação do que a pessoa digita ou escolhe e o mapeamento para o corpo do `PATCH /v1/bots/:id` (o mesmo
// endpoint e os mesmos campos que o web usa: `name`, `shape`, `color`, `language`). Funções puras, testadas.
import { BOT_LANGUAGE_AUTO, BOT_LANGUAGES, isBotLanguageSetting } from "@workspace/shared";
import { SHAPE_IDS } from "@workspace/shared/avatar/geometry/shapes";
import { AVATAR_COLORS, identityFor, normalizeShape } from "@workspace/shared/avatar/identity";

export const BOT_NAME_MAX = 80;

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Nome do bot: não pode ficar vazio (o servidor recusa) e tem até 80 letras (o limite dos campos de nome do web). */
export function validateBotName(raw: string): NameCheck {
	const value = raw.trim().replace(/\s+/g, " ");
	if (!value) return { ok: false, error: "Dê um nome ao bot." };
	if (value.length > BOT_NAME_MAX) return { ok: false, error: `O nome pode ter até ${BOT_NAME_MAX} letras.` };
	return { ok: true, value };
}

/** As formas do seletor: a mesma lista e a mesma ordem do web (`SHAPE_IDS`, das mais simples às mais enfeitadas). */
export const AVATAR_SHAPES: readonly string[] = SHAPE_IDS;
/** A paleta do web (`AVATAR_COLORS`). */
export const AVATAR_PALETTE = AVATAR_COLORS;

/**
 * Formas que trazem a cor própria no desenho (como a abóbora da referência): a paleta some quando uma delas está
 * escolhida. O motor de avatar atual não tem nenhuma, então a lista está vazia; entra aqui quando existir.
 */
export const OWN_COLOR_SHAPES: ReadonlySet<string> = new Set<string>();
export const usesPalette = (shape: string | null | undefined, own: ReadonlySet<string> = OWN_COLOR_SHAPES): boolean => !(shape && own.has(shape));

const HEX = /^#[0-9a-f]{6}$/i;

export const isValidShape = (shape: unknown): shape is string => typeof shape === "string" && normalizeShape(shape) !== undefined;
export const isValidColor = (color: unknown): color is string => typeof color === "string" && HEX.test(color.trim());

/** Forma e cor de fábrica do bot (o mesmo sorteio por id do web): o "Restaurar o padrão". */
export function defaultAvatar(botId: string): { shape: string; color: string } {
	const identity = identityFor(botId);
	return { shape: identity.shape, color: identity.color };
}

export type BotDraft = { name: string; shape: string; color: string; language: string };
export type BotPatch = Partial<BotDraft>;

/** Só o que mudou, já limpo; `null` se algo for inválido (nome, forma, cor ou idioma). Vazio = nada a salvar. */
export function buildBotPatch(original: BotDraft, draft: BotDraft): BotPatch | null {
	const patch: BotPatch = {};
	const name = validateBotName(draft.name);
	if (!name.ok) return null;
	if (name.value !== original.name) patch.name = name.value;
	if (draft.shape !== original.shape) {
		if (!isValidShape(draft.shape)) return null;
		patch.shape = draft.shape;
	}
	if (draft.color.trim().toLowerCase() !== original.color.trim().toLowerCase()) {
		if (!isValidColor(draft.color)) return null;
		patch.color = draft.color.trim();
	}
	if (draft.language !== original.language) {
		if (!isBotLanguageSetting(draft.language)) return null;
		patch.language = draft.language;
	}
	return patch;
}

export const hasChanges = (patch: BotPatch | null): boolean => patch !== null && Object.keys(patch).length > 0;

const LANGUAGE_LABELS: Record<string, string> = { [BOT_LANGUAGE_AUTO]: "Automático", "pt-BR": "Português (Brasil)", "en-US": "English (US)", "es-ES": "Español (España)" };
export const languageLabel = (language: string | null): string => (language ? (LANGUAGE_LABELS[language] ?? language) : "Automático");
/** Opções do seletor de idioma: automático e cada idioma que o servidor suporta. */
export const LANGUAGE_OPTIONS: readonly { value: string; label: string }[] = [BOT_LANGUAGE_AUTO, ...BOT_LANGUAGES].map((value) => ({ value, label: languageLabel(value) }));
