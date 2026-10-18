/** Limites da entrada HTTP; resultados internos de tools não passam por eles. */
export const API_INPUT_LIMITS = {
	jsonBytes: 1024 * 1024,
	messages: 200,
	contentChars: 64 * 1024,
	maxSteps: 500,
} as const;

export function validMaxSteps(value: unknown): boolean {
	return value === undefined || (
		typeof value === "number" && Number.isInteger(value) &&
		value >= 1 && value <= API_INPUT_LIMITS.maxSteps
	);
}
