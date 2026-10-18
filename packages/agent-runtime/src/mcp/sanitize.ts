import { redactSecrets } from "@workspace/shared";

export { redactSecrets };

export function sanitizeErrorMessage(
	error: unknown,
	secrets: readonly string[] = [],
	maxChars = 500,
): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw, secrets).slice(0, maxChars);
}
