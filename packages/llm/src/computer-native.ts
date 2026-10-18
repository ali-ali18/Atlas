/**
 * F12/C4 — ferramenta de computador "nativa" por modelo.
 *
 * O OpenRouter (chat completions) só documenta tools `type: "function"`; os
 * tipos próprios do provedor (`computer_20250124` da Anthropic, `computer` da
 * OpenAI) não passam por ele. Por isso o "nativo" aqui é uma função `computer`
 * com o MESMO vocabulário de ações em que esses modelos foram treinados
 * (screenshot, left_click, type, key, scroll, zoom, wait...), traduzida para o
 * control server. Só aparece para modelos da lista abaixo e com o modo ligado.
 */

export type NativeComputerMode = "off" | "shadow" | "on";

/** `COMPUTER_NATIVE_MODE`: qualquer valor desconhecido vale `off`. */
export function parseNativeComputerMode(value: string | undefined): NativeComputerMode {
	const v = (value ?? "").trim().toLowerCase();
	return v === "on" || v === "shadow" ? v : "off";
}

const SUPPORTED_MODELS: readonly RegExp[] = [
	// Claude com computer use (3.5 Sonnet v2 em diante, família 4+).
	/^anthropic\/claude-(3[.-][57]-sonnet|sonnet|opus|haiku-4)/i,
	/^anthropic\/claude-(3[.-]5-sonnet|3[.-]7-sonnet)/i,
	// Modelo de computer use da OpenAI.
	/^openai\/computer-use/i,
];

export function supportsNativeComputerTool(model: string | undefined): boolean {
	if (!model) return false;
	return SUPPORTED_MODELS.some((pattern) => pattern.test(model.trim()));
}
