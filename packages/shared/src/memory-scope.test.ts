import { describe, expect, it } from "vitest";
import { decideMemoryScope, isRoutineRequest, restatesBotProfile } from "./memory-scope.js";

const ctx = { botNames: ["Cookie", "Grok Bot"], botProfile: null };
const decide = (content: string, category: string | undefined, c: Parameters<typeof decideMemoryScope>[1] = ctx) =>
	decideMemoryScope({ content, category, target: "user", hasBot: true }, c);

describe("decideMemoryScope: os 6 casos reais", () => {
	it("1. descrição do bot não vai ao user", () => {
		expect(decide("Bot Cookie: assistente amigável para tarefas do dia a dia, investimentos e organização financeira.", "identidade")).toMatchObject({ action: "save", target: "memory" });
	});
	it("2. nome/apelido/idioma do usuário fica no user", () => {
		expect(decide('Nome: Alisson Camargo, apelido "ali"; GitHub: ali-ali18. Fala pt-BR e prefere respostas curtas e claras.', "identidade")).toEqual({ action: "save", target: "user" });
	});
	it("3. tom/instruções do bot saem do user", () => {
		expect(decide("Tom amigável; revisões: só corrigir, manter breve e introdutório.", "comunicacao")).toMatchObject({ action: "save", target: "memory" });
	});
	it("4. pedido de rotina é rejeitado", () => {
		expect(decide("Quer uma rotina diária para consultar agenda e e-mail às 7h e às 20h.", "preferencia")).toMatchObject({ action: "reject" });
	});
	it("5. o que ele quer deste bot vai ao bot", () => {
		expect(decide("Ali (Alisson Camargo) quer ajuda principalmente com bugs e documentação no bot, por ser desenvolvedor.", "identidade")).toMatchObject({ action: "save", target: "memory" });
	});
	it("6. fato pessoal estável fica no user", () => {
		expect(decide("É estudante da PUCPR; pode pedir ajuda para acessar o AVA.", "identidade")).toEqual({ action: "save", target: "user" });
	});
});

describe("decideMemoryScope: falsos positivos", () => {
	it("profissão e preferência continuam no user", () => {
		expect(decide("Trabalha como desenvolvedor na empresa X", "identidade")).toEqual({ action: "save", target: "user" });
		expect(decide("Prefere respostas curtas", "comunicacao")).toEqual({ action: "save", target: "user" });
		expect(decide("Quer respostas curtas e diretas", "preferencia")).toEqual({ action: "save", target: "user" });
		expect(decide("Mora em Curitiba; fuso America/Sao_Paulo", "fuso")).toEqual({ action: "save", target: "user" });
		expect(decide("Prefere tom direto nas respostas", "comunicacao")).toEqual({ action: "save", target: "user" });
	});
	it("categoria fora da lista é rebaixada; sem categoria depende de requireCategory", () => {
		expect(decide("Investe em renda fixa", "financas")).toMatchObject({ target: "memory" });
		expect(decide("Investe em renda fixa", undefined)).toMatchObject({ target: "memory" });
		expect(decide("Me chama de Ali", undefined, { ...ctx, requireCategory: false })).toEqual({ action: "save", target: "user" });
	});
	it("nome de bot do usuário rebaixa; sem bot não mexe", () => {
		expect(decide("Gosta de falar com o Cookie sobre finanças", "preferencia")).toMatchObject({ target: "memory" });
		expect(decideMemoryScope({ content: "Quer uma rotina diária às 7h", category: "preferencia", target: "user", hasBot: false }, ctx)).toMatchObject({ action: "reject" });
		expect(decideMemoryScope({ content: "Prefere tom direto", category: "x", target: "user", hasBot: false }, ctx)).toEqual({ action: "save", target: "user" });
	});
	it("target memory passa, exceto rotina", () => {
		expect(decideMemoryScope({ content: "Cliente Silva paga no dia 10", category: "contexto", target: "memory", hasBot: true }, ctx)).toEqual({ action: "save", target: "memory" });
	});
});

describe("isRoutineRequest", () => {
	it("pega agenda + frequência/horário", () => {
		expect(isRoutineRequest("Pediu um lembrete todo dia às 8h para tomar remédio")).toBe(true);
		expect(isRoutineRequest("Quer que eu envie um resumo diariamente às 9h")).toBe(true);
	});
	it("não pega fatos comuns", () => {
		expect(isRoutineRequest("Acorda às 6h e treina de manhã")).toBe(false);
		expect(isRoutineRequest("Trabalha com rotinas de CI na empresa")).toBe(false);
		expect(isRoutineRequest("Reunião semanal às 10h com o time")).toBe(false);
	});
});

describe("restatesBotProfile", () => {
	const profile = { name: "Cookie", snippet: "Assistente amigável", description: "Assistente amigável para tarefas do dia a dia, investimentos e organização financeira." };
	it("repetição do perfil é pulada; fato novo não", () => {
		expect(restatesBotProfile("Cookie: assistente amigável para tarefas do dia a dia e organização financeira", profile)).toBe(true);
		expect(restatesBotProfile("Investe em renda fixa e tesouro direto", profile)).toBe(false);
		expect(decideMemoryScope({ content: "Assistente amigável para tarefas do dia a dia, investimentos e finanças", target: "memory", hasBot: true }, { botProfile: profile })).toMatchObject({ action: "skip" });
	});
});
