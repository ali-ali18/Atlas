import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import {
	allLanguageInstructions,
	autoLanguageInstruction,
	languageInstruction,
	nextLanguageMemory,
	type BotLanguageSetting,
	type LanguageMemory,
} from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
}));

/**
 * Replays do idioma automático com o LLM mockado: o que o modelo recebe no prompt quando o usuário escreve em
 * inglês, quando manda "ok", na rotina seguinte e num grupo. O "gravar" do servidor é a mesma função pura do db
 * (`nextLanguageMemory`), então a cadeia mensagem -> idioma gravado -> próximo run é a de produção.
 */
const EN = "I need you to show me the orders from today and also the stock of the best selling products";
const PT = "Preciso que você me mostre os pedidos de hoje e também o estoque dos produtos mais vendidos";
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Done." } };
const empty: LanguageMemory = { last: null, pending: null };

async function systemOf(input: {
	language?: BotLanguageSetting;
	origin?: "chat" | "routine";
	message: string;
	memory?: LanguageMemory;
	accountLocale?: string | null;
}): Promise<string> {
	let system = "";
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		userId: "user-a",
		origin: input.origin ?? "chat",
		messages: [{ role: "user", content: input.message }],
		language: input.language ?? "auto",
		languageContext: { lastLanguage: input.memory?.last ?? null, accountLocale: input.accountLocale ?? null },
		maxSteps: 1,
		onEvent: () => undefined,
		streamChat: async (params) => {
			system = params.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
			return done;
		},
	});
	return system;
}

describe("idioma automático (replay com LLM mockado)", () => {
	it("usuário escreve em inglês: o modelo recebe a instrução de seguir a mensagem e a rotina seguinte usa en-US", async () => {
		// 1º turno: nada gravado ainda, a conta é pt-BR. O modelo segue a mensagem em inglês.
		const chat = await systemOf({ message: EN, memory: empty });
		expect(chat).toContain(autoLanguageInstruction("pt-BR"));
		expect(chat).toContain("Reply in the language of the user's latest message.");
		expect(chat).not.toContain("- Language:");
		// O servidor grava en-US (com a mensagem já recebida).
		const memory = nextLanguageMemory(empty, EN).memory;
		expect(memory.last).toBe("en-US");
		// A rotina seguinte não tem mensagem do usuário: usa o idioma gravado, com a instrução fixa de sempre.
		const routine = await systemOf({ origin: "routine", message: "Check the stock and report", memory });
		expect(routine).toContain(languageInstruction("en-US"));
		expect(routine).not.toContain("Reply in the language of the user's latest message.");
		expect(routine).not.toContain(languageInstruction("pt-BR"));
	});

	it("'ok' não troca o idioma: nada é gravado e a mensagem ambígua cai no último idioma", async () => {
		const memory = nextLanguageMemory(empty, EN).memory;
		for (const text of ["ok", "👍", "Maria", "```js\nconsole.log(1)\n```"]) {
			const result = nextLanguageMemory(memory, text);
			expect(result.changed).toBe(false);
			expect(result.memory.last).toBe("en-US");
		}
		const chat = await systemOf({ message: "ok", memory });
		expect(chat).toContain("too short or ambiguous (ok, emoji, names, code), reply in American English");
		// Uma mensagem em português sozinha não vira o idioma da rotina; a segunda confirma.
		const once = nextLanguageMemory(memory, PT).memory;
		expect((await systemOf({ origin: "routine", message: "report", memory: once }))).toContain(languageInstruction("en-US"));
		const twice = nextLanguageMemory(once, PT).memory;
		expect((await systemOf({ origin: "routine", message: "report", memory: twice }))).toContain(languageInstruction("pt-BR"));
	});

	it("grupo com duas pessoas: segue quem falou por último, por conversa", async () => {
		let group = empty;
		const say = async (text: string) => {
			group = nextLanguageMemory(group, text).memory;
			return systemOf({ message: text, memory: group });
		};
		// Ana (inglês) abre; Beto (português) fala duas vezes e vira o idioma do grupo; Ana volta.
		expect(await say(EN)).toContain(autoLanguageInstruction("en-US"));
		expect(await say(PT)).toContain(autoLanguageInstruction("en-US"));
		expect(await say(PT)).toContain(autoLanguageInstruction("pt-BR"));
		expect(await say("ok")).toContain(autoLanguageInstruction("pt-BR"));
		expect(await say(EN)).toContain(autoLanguageInstruction("pt-BR"));
		expect(await say(EN)).toContain(autoLanguageInstruction("en-US"));
		// A conversa de outro bot do mesmo usuário tem estado próprio: sem nada gravado cai no locale da conta.
		expect(await systemOf({ message: "ok", memory: empty, accountLocale: "es-MX" })).toContain(autoLanguageInstruction("es-ES"));
	});

	it("sem nada gravado, rotina usa o locale da conta e depois pt-BR", async () => {
		expect(await systemOf({ origin: "routine", message: "report", memory: empty, accountLocale: "en-GB" })).toContain(languageInstruction("en-US"));
		expect(await systemOf({ origin: "routine", message: "report", memory: empty, accountLocale: "fr-FR" })).toContain(languageInstruction("pt-BR"));
	});

	it("bot com idioma fixo não muda: persona no topo, sem instrução de auto", async () => {
		const system = await systemOf({ language: "es-ES", message: EN, memory: nextLanguageMemory(empty, EN).memory });
		expect(system.startsWith("Persona:\n")).toBe(true);
		expect(system.split(languageInstruction("es-ES"))).toHaveLength(2);
		expect(system).not.toContain("latest message");
	});

	it("retomada de checkpoint troca a instrução antiga (fixa ou auto) pela de agora, uma vez só", async () => {
		const resumed = async (previous: string, language: BotLanguageSetting, lastLanguage: string | null) => {
			let system = "";
			await runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => "session-1",
				sandboxEnabled: false,
				apiKey: "test",
				model: "m",
				origin: "chat",
				messages: [{ role: "user", content: "hello" }],
				language,
				languageContext: { lastLanguage },
				maxSteps: 1,
				onEvent: () => undefined,
				restoredCheckpoint: { messages: [{ role: "user", content: "hello" }], llmMessages: [{ role: "system", content: `Original prompt\n${previous}` }, { role: "user", content: "hello" }] },
				streamChat: async (params) => {
					system = String(params.messages.find((m) => m.role === "system")?.content);
					return done;
				},
			});
			return system;
		};
		const fromFixed = await resumed(languageInstruction("pt-BR"), "auto", "en-US");
		expect(fromFixed).toContain(autoLanguageInstruction("en-US"));
		expect(fromFixed).not.toContain(languageInstruction("pt-BR"));
		const fromAuto = await resumed(autoLanguageInstruction("pt-BR"), "es-ES", null);
		expect(fromAuto).toContain(languageInstruction("es-ES"));
		expect(fromAuto).not.toContain("latest message");
		for (const text of [fromFixed, fromAuto]) {
			const count = allLanguageInstructions().filter((instruction) => text.includes(instruction)).length;
			expect(count).toBe(1);
		}
	});
});
