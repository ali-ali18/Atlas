import { describe, expect, it } from "vitest";
import { createCodeShellTool } from "./code-shell.js";
import { createCodeTestTool } from "./code-test.js";
import { commandPreview } from "./command-preview.js";

describe("commandPreview (cartão de aprovação do comando de código)", () => {
	it("comando curto aparece inteiro, sem aviso de corte", () => {
		expect(commandPreview("pnpm exec vitest run src/a.test.ts")).toBe("pnpm exec vitest run src/a.test.ts");
	});

	it("comando de 5.000 caracteres com a carga no final: o final aparece e o corte é anunciado", () => {
		const cmd = `echo ${"a".repeat(4_900)} && rm -rf /workspace/x --marcador-final`;
		const preview = commandPreview(cmd);
		expect(preview).toContain("--marcador-final");
		expect(preview).toMatch(/… \(\+\d+ caracteres\) …/);
		expect(preview.startsWith(cmd.slice(0, 600))).toBe(true);
		expect(preview.endsWith(cmd.slice(-400))).toBe(true);
		expect(preview.length).toBeLessThan(1_200);
	});

	it("limite exato: 1.200 caracteres ainda vai inteiro; 1.201 corta", () => {
		expect(commandPreview("x".repeat(1_200))).toBe("x".repeat(1_200));
		expect(commandPreview("x".repeat(1_201))).toMatch(/\(\+201 caracteres\)/);
	});

	it("segredo é redigido ANTES do corte, então nunca aparece pela metade", () => {
		// Montado em tempo de execução: a higiene do pacote (hygiene.test.ts) não aceita token literal no fonte.
		const token = `ghp_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"}`;
		const cmd = `${"x".repeat(595)}export GITHUB_TOKEN=${token}${"y".repeat(2_000)}`;
		const preview = commandPreview(cmd);
		expect(preview).not.toContain(token.slice(0, 12));
		expect(preview).not.toContain(token.slice(-8));
	});

	it("as tools de shell e de teste usam o mesmo preview no cartão", () => {
		const cmd = `${"a".repeat(3_000)}FINAL_DO_COMANDO`;
		expect(createCodeShellTool().riskFactsFor({ sessionId: "s1", cmd })).toEqual({ target: commandPreview(cmd) });
		expect(createCodeTestTool().riskFactsFor({ sessionId: "s1", cmd })).toEqual({ target: commandPreview(cmd) });
		expect((createCodeShellTool().riskFactsFor({ sessionId: "s1", cmd }) as { target: string }).target).toContain("FINAL_DO_COMANDO");
	});
});
