import { describe, expect, it } from "vitest";
import { buildStableSystemPrompt, buildSystemPrompt, ROUTINE_MODE_LINES, swapLanguageInstruction } from "./prompt-builder.js";

describe("buildStableSystemPrompt", () => {
	it("chat: núcleo → pesquisa → conectores → skills → grupos", () => {
		const out = buildStableSystemPrompt({ base: "CORE", routine: false, research: "\n\nRES", connectors: "\n\nCON", skills: "\n\nSKL", tail: "\n\nTAIL" });
		expect(out).toBe("CORE\n\nRES\n\nCON\n\nSKL\n\nTAIL");
	});

	it("rotina: cabeçalho logo após o núcleo", () => {
		const out = buildStableSystemPrompt({ base: "CORE", routine: true, connectors: "\n\nCON" });
		expect(out.startsWith(`CORE\n\n${ROUTINE_MODE_LINES[1]}`)).toBe(true);
		expect(out.endsWith("\n\nCON")).toBe(true);
		expect(out).toContain("NÃO crie, edite nem liste rotinas");
	});

	it("persona do bot vem antes de tudo (identidade, estilo e idioma num lugar só)", () => {
		expect(buildStableSystemPrompt({ persona: "PERSONA", base: "CORE", routine: true })).toBe(["PERSONA\n\nCORE", ...ROUTINE_MODE_LINES].join("\n"));
	});

	it("subagente: núcleo + conectores, nada mais", () => {
		expect(buildStableSystemPrompt({ base: "SUB", routine: false, connectors: "\n\nCON" })).toBe("SUB\n\nCON");
	});

	it("instalação: diz o domínio do Atlas logo após o núcleo, sem barra final", () => {
		const out = buildStableSystemPrompt({ base: "CORE", routine: false, atlasUrl: "https://agente.exemplo.com/", connectors: "\n\nCON" });
		expect(out.startsWith("CORE\n\nINSTALAÇÃO: você está rodando no app publicado em https://agente.exemplo.com ")).toBe(true);
		expect(out).toContain("nunca crie webhooks");
		// Cada bot tem o próprio nome: o texto não pode chamar o bot de "Atlas".
		expect(out).not.toContain("Atlas");
		expect(out.endsWith("\n\nCON")).toBe(true);
		expect(buildStableSystemPrompt({ base: "CORE", routine: false, atlasUrl: "  " })).toBe("CORE");
	});

	it("é determinístico: mesma entrada, mesmo texto (nada de relógio ou aleatório)", () => {
		const parts = { base: "CORE", routine: false, connectors: "\n\nCON", skills: "\n\nSKL" };
		expect(buildStableSystemPrompt(parts)).toBe(buildStableSystemPrompt(parts));
	});
});

describe("buildSystemPrompt", () => {
	it("idioma sempre por último, linha nativa antes dele", () => {
		expect(buildSystemPrompt({ stable: "S", nativeLine: "NATIVE", languageInstruction: "LANG" })).toBe("S\nNATIVE\nLANG");
		expect(buildSystemPrompt({ stable: "S", languageInstruction: "LANG" })).toBe("S\nLANG");
	});
});

describe("buildSystemPrompt: sem persona", () => {
	it("com a persona o idioma já está no topo: nada de idioma no fim", () => {
		expect(buildSystemPrompt({ stable: "PERSONA LANG\n\nS", todayLine: "T" })).toBe("PERSONA LANG\n\nS\nT");
	});
});

describe("swapLanguageInstruction", () => {
	it("troca o idioma dentro da persona (topo) sem mexer no resto", () => {
		expect(swapLanguageInstruction("Persona:\n- Language: LANG-A\n\nCORE\nT", ["LANG-B", "LANG-A"], "LANG-C")).toBe("Persona:\n- Language: LANG-C\n\nCORE\nT");
	});
	it("troca só o rabo de idioma e preserva o prefixo", () => {
		const prefix = "S\nNATIVE";
		expect(swapLanguageInstruction(`${prefix}\nLANG-A`, ["LANG-B", "LANG-A"], "LANG-C")).toBe(`${prefix}\nLANG-C`);
	});
	it("sem idioma anterior reconhecido, acrescenta", () => {
		expect(swapLanguageInstruction("S", ["X"], "LANG")).toBe("S\nLANG");
	});
});

describe("buildSystemPrompt: data de hoje", () => {
	it("a linha da data fica entre o computador nativo e o idioma (que continua por último)", () => {
		expect(buildSystemPrompt({ stable: "S", nativeLine: "N", todayLine: "T", languageInstruction: "L" })).toBe("S\nN\nT\nL");
		expect(buildSystemPrompt({ stable: "S", languageInstruction: "L" })).toBe("S\nL");
	});
});
