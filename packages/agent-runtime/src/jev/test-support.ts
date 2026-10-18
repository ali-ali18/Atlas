import type { JevRuntime } from "./decide.js";

/**
 * Jev falso para testes: intenção `on`, responde 0 para tudo, exceto as chaves pedidas.
 * Ex.: `jevSaying({ wants_file: 0.95 })` simula o Jev reconhecendo o pedido de arquivo em qualquer idioma.
 */
export function jevSaying(answers: Record<string, number>): JevRuntime {
	return {
		modes: { intent: "on" },
		ask: async ({ questions }) => ({
			model: "typesafe/jev-1.13",
			answers: Object.fromEntries(Object.keys(questions).map((key) => [key, answers[key] ?? 0])),
			durationMs: 1,
		}),
	};
}

export const WANTS_FILE_JEV = jevSaying({ wants_file: 0.95 });
