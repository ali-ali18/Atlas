/**
 * F4 — JSON inválido do modelo não é mais engolido (`{}` → "title vazio"):
 * lança "argumentos inválidos (JSON)" com exemplo do schema.
 */
export function parseArgs(raw: string, schemaExample?: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || "{}");
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`argumentos inválidos (JSON): ${detail}` +
				(schemaExample ? ` Exemplo: ${schemaExample}` : ""),
		);
	}
}
