import { describe, expect, it } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import {
	buildTriageMessages,
	MESSAGE_TRIAGE_MAX_OUTPUT_TOKENS,
	MESSAGE_TRIAGE_SYSTEM,
	parseMessageTriage,
	triageUserMessage,
} from "./message-triage.js";

const reply = (content: string): CompleteChatWithToolsResult => ({
	model: "cheap",
	message: { role: "assistant", content },
	usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60, costUsd: 0.0001 },
});

const base = {
	model: "cheap",
	apiKey: "k",
	objective: "Pesquise baterias e gere um PDF.",
	message: "boa noite",
	languageInstruction: "Reply in Portuguese.",
};

describe("parseMessageTriage", () => {
	it("aceita o formato pedido, inclusive com cerca de markdown ao redor", () => {
		const json = '{"kind":"chat","cancel":false,"reply":"Boa noite!","instruction":""}';
		expect(parseMessageTriage(json)).toEqual({ kind: "chat", cancel: false, reply: "Boa noite!", instruction: "", wantsFile: false });
		const withFile = '{"kind":"change","cancel":false,"reply":"Ok","instruction":"Faça um relatório","wantsFile":true}';
		expect(parseMessageTriage(withFile)).toMatchObject({ kind: "change", wantsFile: true });
		expect(parseMessageTriage('{"kind":"chat","cancel":false,"reply":"a","instruction":"","wantsFile":"sim"}')).toBeNull();
		expect(parseMessageTriage("```json\n" + json + "\n```")?.kind).toBe("chat");
	});

	it.each([
		["vazio", ""],
		["não é JSON", "boa noite!"],
		["kind desconhecido", '{"kind":"x","cancel":false,"reply":"a","instruction":""}'],
		["cancel não booleano", '{"kind":"chat","cancel":"no","reply":"a","instruction":""}'],
		["reply ausente", '{"kind":"chat","cancel":false,"instruction":""}'],
		["reply vazio", '{"kind":"chat","cancel":false,"reply":"  ","instruction":""}'],
		["cancel fora de change", '{"kind":"chat","cancel":true,"reply":"a","instruction":""}'],
		["later sem instrução", '{"kind":"later","cancel":false,"reply":"a","instruction":""}'],
		["change sem instrução e sem cancel", '{"kind":"change","cancel":false,"reply":"a","instruction":""}'],
		["array", '[{"kind":"chat"}]'],
	])("rejeita %s", (_name, raw) => {
		expect(parseMessageTriage(raw)).toBeNull();
	});

	it("change com cancel dispensa instrução; textos são compactados e limitados", () => {
		expect(parseMessageTriage('{"kind":"change","cancel":true,"reply":"Parei.","instruction":""}')).toMatchObject({ cancel: true });
		const long = parseMessageTriage(JSON.stringify({ kind: "later", cancel: false, reply: "a\n\nb".repeat(400), instruction: "x".repeat(2000) }))!;
		expect(long.reply.length).toBeLessThanOrEqual(501);
		expect(long.reply).not.toContain("\n");
		expect(long.instruction.length).toBeLessThanOrEqual(601);
	});
});

describe("triageUserMessage", () => {
	it("pede ao modelo barato JSON curto, sem tools, com objetivo, progresso, mensagem e idioma", async () => {
		let seen: CompleteChatWithToolsParams | undefined;
		const result = await triageUserMessage({
			...base,
			progress: "phase executing; 3 tool calls so far",
			streamChat: async (params) => {
				seen = params;
				return reply('{"kind":"chat","cancel":false,"reply":"Boa noite! Sigo com a pesquisa.","instruction":""}');
			},
		});
		expect(result?.triage.reply).toBe("Boa noite! Sigo com a pesquisa.");
		expect(result?.usage.totalTokens).toBe(60);
		expect(seen).toMatchObject({ model: "cheap", tools: [], toolChoice: "none", maxOutputTokens: MESSAGE_TRIAGE_MAX_OUTPUT_TOKENS });
		expect(seen!.messages[0]!.content).toBe(`${MESSAGE_TRIAGE_SYSTEM}\nReply in Portuguese.`);
		const user = String(seen!.messages[1]!.content);
		expect(user).toContain("Task: Pesquise baterias e gere um PDF.");
		expect(user).toContain("Progress: phase executing; 3 tool calls so far");
		expect(user).toContain("User message:\nboa noite");
	});

	it("o teto de saída cobre o JSON completo de um 'pare tudo' (7 campos) e o prompt pede instrução curta", async () => {
		expect(MESSAGE_TRIAGE_MAX_OUTPUT_TOKENS).toBe(400);
		expect(MESSAGE_TRIAGE_SYSTEM).toContain("Keep instruction");
		let seen: CompleteChatWithToolsParams | undefined;
		const full = JSON.stringify({
			kind: "change",
			cancel: true,
			reply: "Parei tudo, como você pediu.",
			instruction: "",
			wantsFile: false,
			away: false,
			deliverAt: "",
		});
		const result = await triageUserMessage({
			...base,
			message: "para tudo",
			streamChat: async (params) => {
				seen = params;
				return reply(full);
			},
		});
		expect(result?.triage).toMatchObject({ kind: "change", cancel: true });
		expect(seen?.maxOutputTokens).toBe(400);
	});

	it("sem veredito: loga só o motivo (truncated, invalid_json, timeout, other), sem conteúdo do usuário", async () => {
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);
		const secret = "SEGREDO-DO-USUARIO";
		const truncated = { ...reply('{"kind":"change","cancel":true,"reply":"Par'), finishReason: "length" as const };
		await triageUserMessage({ ...base, message: secret, log, streamChat: async () => truncated });
		await triageUserMessage({ ...base, message: secret, log, streamChat: async () => reply("claro!") });
		await triageUserMessage({ ...base, message: secret, log, timeoutMs: 20, streamChat: () => new Promise<never>(() => undefined) });
		await triageUserMessage({
			...base,
			message: secret,
			log,
			streamChat: async () => {
				throw new Error(`falha com ${secret}`);
			},
		});
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("truncated");
		expect(lines[1]).toContain("invalid_json");
		expect(lines[2]).toContain("timeout");
		expect(lines[3]).toContain("other");
		expect(lines.join("\n")).not.toContain(secret);
	});

	it("away: valida o tipo, mantém deliverAt só quando há ausência e limita o tamanho", () => {
		const base = '"kind":"chat","cancel":false,"reply":"Boa noite!","instruction":""';
		expect(parseMessageTriage(`{${base},"away":true,"deliverAt":"2026-10-12T07:00"}`)).toMatchObject({ away: true, deliverAt: "2026-10-12T07:00" });
		expect(parseMessageTriage(`{${base},"away":false,"deliverAt":"2026-10-12T07:00"}`)?.deliverAt).toBeUndefined();
		expect(parseMessageTriage(`{${base}}`)?.away).toBeUndefined();
		expect(parseMessageTriage(`{${base},"away":"sim"}`)).toBeNull();
		expect(parseMessageTriage(`{${base},"away":true,"deliverAt":"${"9".repeat(200)}"}`)?.deliverAt?.length).toBeLessThanOrEqual(41);
	});

	it("o horário local entra na mensagem só quando o chamador informa `now`", () => {
		const input = { objective: "Task", message: "oi", languageInstruction: "", timezone: "America/Sao_Paulo" };
		expect(String(buildTriageMessages(input)[1]!.content)).not.toContain("Current local time");
		const withNow = String(buildTriageMessages({ ...input, now: new Date("2026-10-11T02:30:00.000Z") })[1]!.content);
		expect(withNow).toContain("Current local time: 2026-10-10T23:30");
	});

	it("o prompt do sistema descreve as três classes e o formato de saída", () => {
		expect(MESSAGE_TRIAGE_SYSTEM).toContain("chat = small talk");
		expect(MESSAGE_TRIAGE_SYSTEM).toContain("change = the user changes, narrows, or cancels");
		expect(MESSAGE_TRIAGE_SYSTEM).toContain("later = a request to do something after the current task");
		expect(MESSAGE_TRIAGE_SYSTEM).toContain('{"kind":"chat|change|later","cancel":true|false,"reply":"...","instruction":"...","wantsFile":true|false,"away":true|false,"deliverAt":"..."}');
		expect(buildTriageMessages({ objective: "o", message: "m", languageInstruction: "L" })[1]!.content).not.toContain("Progress:");
	});

	it("JSON inválido, erro e timeout devolvem null (sem lançar)", async () => {
		expect(await triageUserMessage({ ...base, streamChat: async () => reply("claro!") })).toBeNull();
		expect(
			await triageUserMessage({
				...base,
				streamChat: async () => {
					throw new Error("rede com trecho da conversa");
				},
			}),
		).toBeNull();
		const started = Date.now();
		expect(await triageUserMessage({ ...base, timeoutMs: 30, streamChat: () => new Promise<never>(() => undefined) })).toBeNull();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("o abort do run propaga ao signal da chamada", async () => {
		const controller = new AbortController();
		let aborted = false;
		await triageUserMessage({
			...base,
			signal: controller.signal,
			streamChat: async (params) => {
				controller.abort();
				aborted = params.signal?.aborted ?? false;
				return reply("x");
			},
		});
		expect(aborted).toBe(true);
	});
});

describe("triagem recebe as falas anteriores do run", () => {
	it("a mensagem nova vem depois do histórico, que mostra o que o usuário e o agente já disseram", () => {
		const [, user] = buildTriageMessages({
			objective: "Fazer login no site",
			history: [
				{ role: "user", text: "puxe do cofre" },
				{ role: "assistant", text: "Consigo sim: o login do Claude está no cofre." },
			],
			message: "Mas eh falei do gpt",
			languageInstruction: "Reply in Portuguese.",
		});
		const content = String(user!.content);
		expect(content.indexOf("User: puxe do cofre")).toBeGreaterThan(-1);
		expect(content.indexOf("You: Consigo sim")).toBeGreaterThan(content.indexOf("User: puxe do cofre"));
		expect(content.indexOf("User message:\nMas eh falei do gpt")).toBeGreaterThan(content.indexOf("You: Consigo sim"));
	});
});
