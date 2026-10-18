/**
 * Controle de admissão: antes de subir (ou religar) um container de
 * desenvolvimento, confere teto de concorrência e orçamento de memória.
 * Pura: o chamador fornece o que está rodando e a memória livre do host.
 */

export type AdmissionInput = {
	/** Containers de desenvolvimento rodando agora, com o limite de memória de cada um. */
	running: ReadonlyArray<{ memoryMb: number }>;
	requestedMb: number;
	maxConcurrent: number;
	memoryBudgetMb: number;
	/** Memória disponível no host (MB); `undefined` = desconhecida (não bloqueia). */
	hostFreeMb?: number;
	minFreeMb: number;
};

export type AdmissionDenied = {
	admit: false;
	reason: "max_concurrent" | "memory_budget" | "host_memory";
	message: string;
};
export type AdmissionDecision = { admit: true } | AdmissionDenied;

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
	if (input.running.length >= input.maxConcurrent) {
		return {
			admit: false,
			reason: "max_concurrent",
			message: `Já há ${input.running.length} ambientes de desenvolvimento ativos (máximo ${input.maxConcurrent}).`,
		};
	}
	const committed = input.running.reduce((sum, item) => sum + item.memoryMb, 0);
	if (committed + input.requestedMb > input.memoryBudgetMb) {
		return {
			admit: false,
			reason: "memory_budget",
			message: `Orçamento de memória esgotado (${committed} MB em uso de ${input.memoryBudgetMb} MB; este ambiente pede ${input.requestedMb} MB).`,
		};
	}
	if (input.hostFreeMb !== undefined && input.hostFreeMb - input.requestedMb < input.minFreeMb) {
		return {
			admit: false,
			reason: "host_memory",
			message: `Pouca memória livre no servidor (${Math.round(input.hostFreeMb)} MB livres).`,
		};
	}
	return { admit: true };
}
