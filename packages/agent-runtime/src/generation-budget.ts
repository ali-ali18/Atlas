/** Arquivos podem exigir argumentos extensos; não imponha o teto implícito de chat. */
export function agentOutputBudget(input: {
	configured?: number;
	remaining?: number;
	canCreateFiles: boolean;
}): number | undefined {
	if (
		input.configured !== undefined &&
		(!Number.isInteger(input.configured) ||
			input.configured < 1 ||
			input.configured > 1_000_000)
	)
		throw new RangeError("Invalid generation token budget");
	const desired = input.configured ?? (input.canCreateFiles ? undefined : 4096);
	if (input.remaining === undefined) return desired;
	return Math.max(
		1,
		Math.min(desired ?? Infinity, Math.floor(input.remaining)),
	);
}
