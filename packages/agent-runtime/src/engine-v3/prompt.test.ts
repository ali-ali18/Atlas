import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY_LEVEL, autoLanguageInstruction, buildPersonaBlock, languageInstruction, renderLessonsBlock } from "@workspace/shared";
import { eligibleNativeTools } from "../engine-v2/catalog.js";
import { ENGINE_V2_UNATTENDED } from "../engine-v2/prompt.js";
import { CONTEXT_HEADER, assembleV3Conversation, buildV3ContextBlock, buildV3SystemPrompt, isContextMessage } from "./prompt.js";

const persona = (language: "pt-BR" | "auto") => buildPersonaBlock({ name: "Cookie", role: "Assistente pessoal.", language });

describe("motor v3: bloco estável (system)", () => {
	it("curto, em inglês, com SOUL, trabalho, ponte e idioma; no máximo 3 \"never\" no núcleo", () => {
		const system = buildV3SystemPrompt({ persona: persona("pt-BR"), model: "anthropic/claude-sonnet-4.5", bridge: true, languageInstruction: languageInstruction("pt-BR") });
		expect(system.length).toBeLessThanOrEqual(6_000);
		expect(system).toMatch(/^Persona:\n- You are "Cookie"/);
		expect(system).toContain("A reply without a tool call ends your turn");
		expect(system).toContain("tool_call(name, args)");
		expect(system.split(languageInstruction("pt-BR"))).toHaveLength(2); // uma vez só (na persona)
		const work = system.slice(system.indexOf("How you work:"), system.indexOf("Tools:"));
		expect(work.match(/\bnever\b/gi)?.length ?? 0).toBeLessThanOrEqual(3);
		// Sem acentos do português no texto que vai ao modelo (só a persona traz dados do bot).
		expect(system.replace(persona("pt-BR"), "")).not.toMatch(/[áéíóúãõç]/i);
	});

	it("modo auto: a instrução de idioma vai por último (o resto do prefixo não muda com o idioma)", () => {
		const system = buildV3SystemPrompt({ persona: persona("auto"), model: "m", bridge: false, languageInstruction: autoLanguageInstruction("pt-BR") });
		expect(system.endsWith(autoLanguageInstruction("pt-BR"))).toBe(true);
		// Sem tools fora do núcleo, o bloco da ponte não entra (regra que cita tool ausente não entra).
		expect(system).not.toContain("tool_call");
	});

	it("sem humano: contrato da origem entra; rotina traz o modo de execução", () => {
		const system = buildV3SystemPrompt({ persona: persona("pt-BR"), model: "m", bridge: true, unattended: true, routine: true, languageInstruction: languageInstruction("pt-BR") });
		expect(system).toContain(ENGINE_V2_UNATTENDED[0]);
		expect(system).toContain("MODO EXECUÇÃO DE ROTINA");
	});
});

describe("motor v3: contexto e volátil", () => {
	it("contexto = manifesto + skills (só com skill_read) + retrato de memória, com a 1ª linha fixa", () => {
		const block = buildV3ContextBlock({ manifest: "Other tools...", skillIndex: "- relatorio: monthly report", canReadSkills: true, snapshot: ["USER: Ana"] });
		expect(block.startsWith(`${CONTEXT_HEADER}\n`)).toBe(true);
		expect(block).toContain("Skill index");
		expect(block).toContain("USER: Ana");
		expect(buildV3ContextBlock({ manifest: "m", skillIndex: "- x: y", canReadSkills: false, snapshot: [] })).not.toContain("Skill index");
		expect(buildV3ContextBlock({ manifest: "", canReadSkills: false, snapshot: [] })).toBe("");
	});

	it("monta system → contexto → histórico → volátil → fala; nota do turno vai para o volátil; nenhum system extra", () => {
		const conversation = assembleV3Conversation({
			system: "S",
			contextFor: (snapshot) => buildV3ContextBlock({ manifest: "M", canReadSkills: false, snapshot }),
			messages: [
				{ role: "system", content: "USER: Ana" },
				{ role: "system", content: "[[slot]]" },
				{ role: "user", content: "oi" },
				{ role: "system", content: "Nota do turno" },
			],
			priorHistory: [
				{ role: "user", content: `${CONTEXT_HEADER}\n\nmanifesto antigo` },
				{ role: "user", content: "antes" },
				{ role: "assistant", content: "ok" },
			],
			slot: "[[slot]]",
			volatile: ["Now is 10:00"],
		});
		expect(conversation.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "user", "user"]);
		expect(isContextMessage(conversation[1]!)).toBe(true);
		expect(conversation[1]!.content).toContain("USER: Ana");
		expect(conversation[2]!.content).toBe("antes");
		expect(conversation[4]!.content).toBe("[runtime] Now is 10:00\n\nNota do turno");
		expect(conversation[5]!.content).toBe("oi");
	});
});

describe("motor v3: lições não entram no prompt (PR8c, lições viram fatos)", () => {
	const lessonsBlock = renderLessonsBlock([{ id: "cl1a2b", content: "Ao enviar relatório, use PDF" }])!;
	const build = (leading: string[]) =>
		assembleV3Conversation({
			system: "S",
			contextFor: (snapshot) => buildV3ContextBlock({ manifest: "M", canReadSkills: false, snapshot }),
			messages: [...leading.map((content) => ({ role: "system", content })), { role: "user", content: "oi" }],
			priorHistory: [],
			slot: "[[slot]]",
			volatile: [],
		});
	const text = (conversation: ReturnType<typeof build>) => JSON.stringify(conversation);

	it("com lições no banco: o bloco de lições não aparece, os fatos da memória continuam", () => {
		const withLessons = build(["USER: Ana", "Fato: prefere PDF", lessonsBlock]);
		expect(text(withLessons)).not.toContain("LIÇÕES APRENDIDAS");
		expect(text(withLessons)).not.toContain("Ao enviar relatório, use PDF");
		expect(text(withLessons)).not.toContain("lesson_feedback");
		expect(text(withLessons)).toContain("Fato: prefere PDF");
	});

	it("sem lições no banco: o prompt é byte a byte o mesmo", () => {
		expect(build(["USER: Ana", "Fato: prefere PDF", lessonsBlock])).toEqual(build(["USER: Ana", "Fato: prefere PDF"]));
	});
});

describe("motor v3: lições no histórico de um run v2 (PR8c, auditoria)", () => {
	const lessonsBlock = renderLessonsBlock([{ id: "cl1a2b", content: "Ao enviar relatório, use PDF" }])!;
	const run = (prior: Array<{ role: "system" | "user" | "assistant"; content: string }>) =>
		JSON.stringify(
			assembleV3Conversation({
				system: "S",
				contextFor: () => "",
				messages: [{ role: "system", content: "[[slot]]" }, { role: "user", content: "oi" }],
				priorHistory: prior,
				slot: "[[slot]]",
				volatile: [],
			}),
		);

	it("system do v2 com o bloco de lições não volta como [runtime]", () => {
		const out = run([{ role: "system", content: lessonsBlock }, { role: "user", content: "antes" }]);
		expect(out).not.toContain("LIÇÕES APRENDIDAS");
		expect(out).toContain("antes");
	});

	it("o bloco já convertido em [runtime] também sai, e outras notas do v2 continuam", () => {
		const out = run([{ role: "user", content: `[runtime] ${lessonsBlock}` }, { role: "system", content: "Nota do v2" }]);
		expect(out).not.toContain("LIÇÕES APRENDIDAS");
		expect(out).toContain("[runtime] Nota do v2");
	});
});

describe("motor v3: lesson_feedback fora do catálogo (PR8c, auditoria)", () => {
	it("sem as refs de lição no prompt, a tool não existe no v3, nem com lições no run", () => {
		const natives = eligibleNativeTools({ origin: "chat", userId: "u1", sandboxEnabled: true, autonomy: { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] }, apiConnector: false, attachments: { present: false } });
		expect(natives.map((tool) => tool.function.name)).not.toContain("lesson_feedback");
	});
});
