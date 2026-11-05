// Leitura defensiva das respostas das Configurações (`/v1/settings`, `/v1/autonomy`, `/v1/usage`). O app não confia no
// formato: campo faltando ou de tipo errado vira o padrão (ou `null` quando não dá para saber), nunca estoura.
import { type AutonomyLevel, type BotLanguageSetting, isAutonomyLevel, isBotLanguageSetting, isUsagePeriod, isValidTimeZone, type UsagePeriod } from "@workspace/shared";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numberOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** O que o app mostra e edita da conta. */
export type AccountSettings = {
	/** Fuso guardado na conta; `null` = a conta não escolheu. */
	timezone: string | null;
	/** Idioma dos bots novos: um fixo ou "auto". */
	botLanguage: BotLanguageSetting;
	/** Abrir o navegador do computador do bot sozinho (padrão: ligado). */
	sandboxAutoStart: boolean;
};

export const DEFAULT_BOT_LANGUAGE_SETTING: BotLanguageSetting = "auto";

/** `GET/PATCH /v1/settings`: lê o que vale de fato (`effective`). Sem `effective` utilizável, `null`. */
export function parseAccountSettings(body: unknown): AccountSettings | null {
	if (!isRecord(body) || !isRecord(body.effective)) return null;
	const effective = body.effective;
	const general = isRecord(effective.general) ? effective.general : {};
	const timezone = isRecord(general.timezone) && isValidTimeZone(general.timezone.value) ? general.timezone.value : null;
	const language = isRecord(general.defaultBotLanguage) ? general.defaultBotLanguage.value : undefined;
	const sandbox = isRecord(effective.sandboxAutoStart) ? effective.sandboxAutoStart.value : undefined;
	return {
		timezone,
		botLanguage: isBotLanguageSetting(language) ? language : DEFAULT_BOT_LANGUAGE_SETTING,
		sandboxAutoStart: typeof sandbox === "boolean" ? sandbox : true,
	};
}

/** `GET/PUT /v1/autonomy`: o nível que vale para a conta (`effective.level`). */
export function parseAutonomyLevel(body: unknown): AutonomyLevel | null {
	if (!isRecord(body) || !isRecord(body.effective)) return null;
	return isAutonomyLevel(body.effective.level) ? body.effective.level : null;
}

export type UsageTotalsView = {
	runs: number;
	costUsd: number | null;
	costUnknownCalls: number;
	planCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
};

export type UsageRowView = UsageTotalsView & { key: string; label: string };

export type UsageView = {
	period: UsagePeriod;
	totals: UsageTotalsView;
	byBot: UsageRowView[];
	byModel: UsageRowView[];
};

function parseTotals(value: unknown): UsageTotalsView | null {
	if (!isRecord(value)) return null;
	return {
		runs: numberOr(value.runs, 0),
		costUsd: typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : null,
		costUnknownCalls: numberOr(value.costUnknownCalls, 0),
		planCalls: numberOr(value.planCalls, 0),
		promptTokens: numberOr(value.promptTokens, 0),
		completionTokens: numberOr(value.completionTokens, 0),
		cachedTokens: numberOr(value.cachedTokens, 0),
	};
}

function parseRows(value: unknown, labelField: "name" | "model"): UsageRowView[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((row, index) => {
		const totals = parseTotals(row);
		if (!totals || !isRecord(row)) return [];
		const label = typeof row[labelField] === "string" ? (row[labelField] as string) : "";
		return [{ ...totals, key: typeof row.key === "string" ? row.key : String(index), label }];
	});
}

/** `GET /v1/usage`: totais e quebra por bot e por modelo. Sem `totals`, `null`. */
export function parseUsage(body: unknown): UsageView | null {
	if (!isRecord(body)) return null;
	const totals = parseTotals(body.totals);
	if (!totals || !isUsagePeriod(body.period)) return null;
	return { period: body.period, totals, byBot: parseRows(body.byBot, "name"), byModel: parseRows(body.byModel, "model") };
}
