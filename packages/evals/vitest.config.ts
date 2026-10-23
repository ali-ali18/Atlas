import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// O pacote do banco exige um pepper ao carregar; o modo mock não grava nada. A economia de contexto roda como
		// em produção (o runner também a liga explicitamente).
		env: { ATLAS_HOOK_PEPPER: "evals-test-pepper", ATLAS_CONTEXT_ECONOMY: "on", DEV_AFTER_EDIT_DIAGNOSTICS: "off" },
		testTimeout: 60_000,
	},
});
