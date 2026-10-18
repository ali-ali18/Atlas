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
		env: { ATLAS_CONTEXT_ECONOMY: "on", DEV_AFTER_EDIT_DIAGNOSTICS: "off" },
	},
});
