/**
 * Modelo puro da seção Habilidades: busca/filtro, rótulos, validação do
 * formulário e mapeamento para o payload da API. Sem React nem `fetch`.
 */
import {
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	validateSkillFields,
} from "@workspace/shared";
import type { BuiltinSkillView, SkillDocView, SkillWriteInput } from "@/lib/atlas-api";
import { formatDate } from "@/lib/format";
import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";
import { formatNumber } from "@/lib/format";
import { normalizeSearch } from "./settings-registry";

export { SKILL_BODY_MAX_BYTES, SKILL_DESCRIPTION_MAX_CHARS };

/** `all`, `account` (sem bot) ou `bot:<id>`. */
export type SkillScopeFilter = string;
export const SCOPE_ALL = "all";
export const SCOPE_ACCOUNT = "account";

export type BotRef = { id: string; name: string };

/** Textos no idioma da tela por padrão (`getActiveTranslator`): o hook de skills chama sem passar o tradutor. */
export function scopeFilterOptions(bots: readonly BotRef[], { t }: Translator = getActiveTranslator()): { value: SkillScopeFilter; label: string }[] {
	return [
		{ value: SCOPE_ALL, label: t("settings.skills.scopeAll") },
		{ value: SCOPE_ACCOUNT, label: t("settings.skills.scopeAccount") },
		...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
	];
}

export function scopeLabel(skill: Pick<SkillDocView, "botId">, bots: readonly BotRef[], { t }: Translator = getActiveTranslator()): string {
	if (!skill.botId) return t("settings.skills.scopeAccount");
	return bots.find((bot) => bot.id === skill.botId)?.name ?? t("settings.skills.botRemoved");
}

/** Busca (sem acento/caixa) por nome e descrição + filtro de escopo. */
export function filterSkills(
	skills: readonly SkillDocView[],
	{ query, scope }: { query: string; scope: SkillScopeFilter },
): SkillDocView[] {
	const text = normalizeSearch(query);
	return skills.filter((skill) => {
		if (scope === SCOPE_ACCOUNT && skill.botId) return false;
		if (scope.startsWith("bot:") && skill.botId !== scope.slice(4)) return false;
		if (!text) return true;
		return normalizeSearch(`${skill.name} ${skill.description}`).includes(text);
	});
}

/** Ativas (e desativadas pelo dono) numa lista; rascunhos em outra, recolhida. */
export function partitionSkills(skills: readonly SkillDocView[]): {
	active: SkillDocView[];
	drafts: SkillDocView[];
} {
	return {
		active: skills.filter((skill) => skill.status !== "draft"),
		drafts: skills.filter((skill) => skill.status === "draft"),
	};
}

export function statusLabel(skill: Pick<SkillDocView, "status" | "enabled">, { t }: Translator = getActiveTranslator()): string {
	if (skill.status === "draft") return t("settings.skills.status.draft");
	return skill.enabled ? t("settings.skills.status.active") : t("settings.skills.status.disabled");
}

export function originLabel(createdBy: SkillDocView["createdBy"], { t }: Translator = getActiveTranslator()): string {
	return createdBy === "agent" ? t("settings.skills.origin.agent") : t("settings.skills.origin.you");
}

/** "06/10/2026" no fuso do navegador (ou o informado, nos testes). */
export function formatSkillDate(iso: string, timeZone?: string, { locale }: Translator = getActiveTranslator()): string {
	return formatDate(iso, locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Troca uma skill na lista (switch otimista e rollback). */
export function patchSkillInList(
	skills: readonly SkillDocView[],
	id: string,
	patch: Partial<SkillDocView>,
): SkillDocView[] {
	return skills.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill));
}

export function sortSkills(skills: readonly SkillDocView[]): SkillDocView[] {
	return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rascunho vira ativo ao ligar o switch; ao desligar só desliga. */
export function togglePatch(skill: Pick<SkillDocView, "status">, enabled: boolean) {
	return enabled && skill.status === "draft"
		? { enabled: true, status: "active" as const }
		: { enabled };
}

export const importNotice = ({ t }: Translator = getActiveTranslator()): string => t("settings.skills.importNotice");

export function deleteConfirmText(skill: Pick<SkillDocView, "name">, { t }: Translator = getActiveTranslator()): { title: string; description: string } {
	return {
		title: t("settings.skills.deleteTitle", { name: skill.name }),
		description: t("settings.skills.deleteBody"),
	};
}

export function exportFileName(skill: Pick<SkillDocView, "name">): string {
	return `${skill.name}.md`;
}

/** Rascunhos do escopo escolhido (ignora a busca): é o que "Apagar rascunhos" remove. */
export function draftsInScope(skills: readonly SkillDocView[], scope: SkillScopeFilter): SkillDocView[] {
	return partitionSkills(filterSkills(skills, { query: "", scope })).drafts;
}

/** Escopo do filtro → parâmetros da rota de apagar rascunhos em lote. */
export function draftScopeParams(scope: SkillScopeFilter): { botId?: string; account?: boolean } {
	if (scope === SCOPE_ACCOUNT) return { account: true };
	if (scope.startsWith("bot:")) return { botId: scope.slice(4) };
	return {};
}

export function deleteDraftsConfirmText(count: number, { t, tn }: Translator = getActiveTranslator()): { title: string; description: string } {
	return {
		title: tn("settings.skills.deleteDraftsTitle", count),
		description: t("settings.skills.deleteDraftsBody"),
	};
}

export const draftSwitchHint = ({ t }: Translator = getActiveTranslator()): string => t("settings.skills.draftSwitchHint");

export function emptyListText(total: number, filtered: boolean, { t }: Translator = getActiveTranslator()): string {
	if (total === 0) return t("settings.skills.emptyNone");
	return filtered ? t("settings.skills.emptyFiltered") : "";
}

// --- formulário do editor ---

export type SkillForm = {
	name: string;
	description: string;
	body: string;
	/** Lista separada por vírgula (dica, nunca permissão). */
	toolsText: string;
	/** `null` = conta. Fixo depois de criada. */
	botId: string | null;
};

export const EMPTY_SKILL_FORM: SkillForm = { name: "", description: "", body: "", toolsText: "", botId: null };

export function formFromSkill(skill: SkillDocView): SkillForm {
	return {
		name: skill.name,
		description: skill.description,
		body: skill.body ?? "",
		toolsText: skill.tools.join(", "),
		botId: skill.botId,
	};
}

/** Há alterações a perder? Compara o formulário atual com o que o editor abriu. */
export function isSkillFormDirty(initial: SkillForm, current: SkillForm): boolean {
	return (
		initial.name !== current.name ||
		initial.description !== current.description ||
		initial.body !== current.body ||
		parseToolsText(initial.toolsText).join(",") !== parseToolsText(current.toolsText).join(",") ||
		initial.botId !== current.botId
	);
}

export function discardConfirm({ t }: Translator = getActiveTranslator()) {
	return {
		title: t("settings.skills.discardTitle"),
		description: t("settings.skills.discardBody"),
		keep: t("settings.skills.discardKeep"),
		discard: t("settings.skills.discardConfirm"),
	};
}

export function parseToolsText(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function bodyBytes(body: string): number {
	return new TextEncoder().encode(body).length;
}

export function bodyCounterLabel(body: string, { t, locale }: Translator = getActiveTranslator()): string {
	return t("settings.skills.bodyCounter", {
		used: formatNumber(bodyBytes(body) / 1024, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
		max: SKILL_BODY_MAX_BYTES / 1024,
	});
}

export type SkillFormErrors = Partial<Record<"name" | "description" | "body" | "tools", string>>;

function fieldOfError(message: string): keyof SkillFormErrors {
	if (message.startsWith("O nome")) return "name";
	if (message.startsWith("A descrição")) return "description";
	if (message.startsWith("O corpo")) return "body";
	return "tools";
}

/** As mensagens de `validateSkillFields` (shared) são pt-BR: reconhece cada uma e devolve no idioma da tela. */
export function translateSkillError(message: string, { t }: Translator = getActiveTranslator()): string {
	const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
		[/^O nome é obrigatório\.$/, () => t("settings.skills.err.nameRequired")],
		[/^O nome deve ser um slug .* com até (\d+) caracteres\.$/, (m) => t("settings.skills.err.nameSlug", { max: m[1]! })],
		[/^A descrição é obrigatória\.$/, () => t("settings.skills.err.descRequired")],
		[/^A descrição deve ter uma única linha\.$/, () => t("settings.skills.err.descSingleLine")],
		[/^A descrição deve ter até (\d+) caracteres\.$/, (m) => t("settings.skills.err.descMax", { max: m[1]! })],
		[/^O corpo da skill não pode ficar vazio\.$/, () => t("settings.skills.err.bodyEmpty")],
		[/^O corpo deve ter até (\d+) KB\.$/, (m) => t("settings.skills.err.bodyMax", { max: m[1]! })],
		[/^tools deve ser uma lista\.$/, () => t("settings.skills.err.toolsList")],
		[/^tools aceita até (\d+) itens\.$/, (m) => t("settings.skills.err.toolsMax", { max: m[1]! })],
		[/^Item inválido em tools: (.*)\.$/, (m) => t("settings.skills.err.toolsItem", { item: m[1]! })],
	];
	for (const [pattern, render] of patterns) {
		const match = message.match(pattern);
		if (match) return render(match);
	}
	return message;
}

/** Valida com a mesma regra do servidor (`validateSkillFields`), por campo, no idioma da tela. */
export function validateSkillForm(
	form: SkillForm,
	translator: Translator = getActiveTranslator(),
): { ok: true; input: SkillWriteInput } | { ok: false; errors: SkillFormErrors } {
	const result = validateSkillFields({
		name: form.name,
		description: form.description,
		body: form.body,
		tools: parseToolsText(form.toolsText),
	});
	if (!result.ok) {
		const errors: SkillFormErrors = {};
		for (const raw of result.errors) {
			const field = fieldOfError(raw);
			const message = translateSkillError(raw, translator);
			errors[field] = errors[field] ? `${errors[field]} ${message}` : message;
		}
		return { ok: false, errors };
	}
	const { name, description, body, tools } = result.skill;
	return { ok: true, input: { name, description, body, tools, botId: form.botId } };
}

/** Mensagem para o erro da API (409 nome repetido/revisão velha, 413 grande, 422 limite). */
export function skillErrorMessage(error: unknown, { t }: Translator = getActiveTranslator()): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	const message = error instanceof Error ? error.message : "";
	switch (status) {
		case 409:
			return message || t("settings.skills.api.conflict");
		case 413:
			return t("settings.skills.api.tooBig");
		case 422:
			return message || t("settings.skills.api.limit");
		case 404:
			return t("settings.skills.api.notFound");
		case 400:
			return message || t("settings.skills.api.invalid");
		default:
			return t("settings.skills.api.generic");
	}
}

// --- skills de fábrica ---

export const builtinGroupTitle = ({ t }: Translator = getActiveTranslator()): string => t("settings.skills.builtinTitle");
export const builtinGroupHint = ({ t }: Translator = getActiveTranslator()): string => t("settings.skills.builtinHint");

/** Busca (sem acento/caixa) por nome, slug e descrição. */
export function filterBuiltins(builtins: readonly BuiltinSkillView[], query: string): BuiltinSkillView[] {
	const text = normalizeSearch(query);
	if (!text) return [...builtins];
	return builtins.filter((skill) => normalizeSearch(`${skill.name} ${skill.slug} ${skill.description}`).includes(text));
}

/** O filtro de escopo só vale para as do dono: as de fábrica somem quando se filtra por bot. */
export function builtinsVisibleForScope(scope: SkillScopeFilter): boolean {
	return !scope.startsWith("bot:");
}

export function duplicateErrorMessage(error: unknown, translator: Translator = getActiveTranslator()): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	if (status === 409) return translator.t("settings.skills.duplicateConflict");
	return skillErrorMessage(error, translator);
}
