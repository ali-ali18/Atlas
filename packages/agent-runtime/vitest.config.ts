import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// `evals/web` é o harness de avaliação da VM (fixtures, checkers, runner); os testes dele
		// rodam sem LLM e sem rede externa.
		include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
		// A economia de contexto (tools nativas adiadas, prompt por intenção) é o padrão em
		// produção, então a suíte roda como produção. Teste que precisa do conjunto completo
		// de tools passa `contextEconomy: false` e diz por quê.
		// Typecheck em segundo plano depois de editar só roda onde o teste liga de propósito.
		// A nota de data e hora é uma camada efêmera no fim de todo pedido; fica desligada aqui para as suítes
		// que fixam o formato exato do pedido (prefixo, último item). Quem testa a nota liga com `vi.stubEnv`.
		env: { ATLAS_CONTEXT_ECONOMY: "on", DEV_AFTER_EDIT_DIAGNOSTICS: "off", ATLAS_NOW_NOTE: "off" },
	},
});
