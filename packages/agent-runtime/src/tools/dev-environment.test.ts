import { describe, expect, it } from "vitest";
import { formatEnvironment, type DevEnvironmentRuntime } from "./dev-environment.js";

const base: DevEnvironmentRuntime = { id: "e1", repo: "acme/site", installCommand: "pnpm install", startCommand: null, tier: "small", network: "allowlist", allowlist: [], secrets: {} };

describe("formatEnvironment: teste rápido", () => {
	it("mostra o comando e manda preferi-lo", () => {
		const text = formatEnvironment("acme/site", { ...base, testCommand: "pnpm --filter @app/api test" });
		expect(text).toContain("Teste rápido: pnpm --filter @app/api test");
		expect(text).toContain("prefira este comando");
	});
	it("sem comando, manda testar só o que mudou", () => {
		expect(formatEnvironment("acme/site", base)).toContain("Teste rápido: (nenhum; rode só os testes dos pacotes que você mudou)");
	});
});
