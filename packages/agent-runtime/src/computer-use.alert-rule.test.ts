import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createRoutine, listRoutines } from "@workspace/db";
import { runComputerUse, COMPUTER_USE_TOOLS } from "./computer-use.js";
import { groupProcedureText } from "./context/prompt-blocks.js";
import type { AlertRuleReader } from "./tools/alert-rule.js";

/** Alerta com regra: o bot grava a regra, o servidor confere sozinho; a regra é testada ao vivo na criação. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		listRoutines: vi.fn(async () => []),
		createRoutine: vi.fn(),
		updateRoutine: vi.fn(),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const closing: CompleteChatWithToolsResult = { model: "test-model", message: { role: "assistant", content: "Pronto." } };

const URL_LOJA = "https://loja.example.com/tenis-pegasus?id=7";
const RULE = {
	source: { type: "page", url: URL_LOJA, extract: { kind: "css", selector: "span.price", attribute: "content" } },
	check: { kind: "value", parse: "money", op: "lt", value: 400 },
	label: "tênis Nike Pegasus",
	intervalMinutes: 120,
};
const SNEAKER = { action: "create", title: "Tênis Pegasus", detail: "Server-checked price alert.", trigger_type: "interval", alert: { rule: RULE } };

const reads = (text: string | null): AlertRuleReader => vi.fn(async () => ({ ok: true as const, read: { kind: "text" as const, text }, host: "loja.example.com", ms: 5 }));

function row(alert: Record<string, unknown>, every = 120) {
	return { id: "r1", userId: "user-1", botId: "bot-1", conversationId: null, name: "Tênis Pegasus", prompt: "x", model: "", enabled: true, triggerType: "interval" as const, schedule: null, interval: { everyMinutes: every }, timezone: "America/Sao_Paulo", lastRunAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), alert };
}

async function run(input: { message: string; calls: CompleteChatWithToolsResult[]; reader: AlertRuleReader }) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const seenTools: string[][] = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "s",
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: input.message }],
		runId: "run-rule", conversationId: "conv-rule", botId: "bot-1", userId: "user-1", maxSteps: 6,
		origin: "chat",
		alertRuleReader: input.reader,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
		},
		streamChat: async (params) => {
			seenTools.push(params.tools.map((tool) => tool.function.name));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults, seenTools };
}

describe("propose_routine com alert.rule", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("a tool e o prompt ensinam quando usar regra e quando usar condição simples", () => {
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "propose_routine")!;
		expect(tool.function.description).toMatch(/alert\.rule/);
		const schema = JSON.stringify(tool.function.parameters);
		expect(schema).toContain("jsonpath");
		expect(schema).toContain("intervalMinutes");
		expect(schema).not.toMatch(/"required":\["condition"\]/);
		const prompt = groupProcedureText(new Set(["routines"]));
		expect(prompt).toContain("EXACT value or a NEW ITEM");
		expect(prompt).toContain("plain condition");
		expect(prompt).toContain("At most 30 active alerts");
	});

	it("replay: 'me avisa se o tênis X baixar de R$ 400 em <url>' grava uma regra de página, lê agora e diz o valor", async () => {
		const reader = reads("R$ 449,90");
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: row({ condition: "tênis Nike Pegasus ficar abaixo de R$ 400,00", active: false, rule: RULE }) } as never);
		const { toolResults, seenTools } = await run({ message: `me avisa se o tênis Nike Pegasus baixar de R$ 400 em ${URL_LOJA}`, calls: [toolCall("c1", "propose_routine", SNEAKER), closing], reader });
		expect(seenTools[0]).toContain("propose_routine");
		expect(reader).toHaveBeenCalledTimes(1);
		const created = vi.mocked(createRoutine).mock.calls[0]![1] as { alert: { condition: string; rule: { source: { type: string; url: string; extract: { kind: string } }; check: { op: string; value: number } } }; trigger: { everyMinutes: number } };
		expect(created.alert.rule.source).toMatchObject({ type: "page", url: URL_LOJA, extract: { kind: "css" } });
		expect(created.alert.rule.check).toMatchObject({ op: "lt", value: 400 });
		expect(created.alert.condition).toMatch(/^tênis Nike Pegasus ficar abaixo de R\$ 400,00$/);
		expect(created.trigger).toEqual({ kind: "interval", everyMinutes: 120 });
		expect(toolResults[0]).toMatchObject({ ok: true });
		expect(toolResults[0]!.summary).toContain("Current reading: R$ 449,90");
	});

	it("regra que não lê o valor falha com motivo e dica, e nada é criado", async () => {
		const { toolResults } = await run({ message: "me avisa se baixar de 400", calls: [toolCall("c1", "propose_routine", SNEAKER), closing], reader: reads(null) });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/Rule test failed: .*não encontrei o valor/);
		expect(toolResults[0]!.summary).toMatch(/another selector|plain `condition`/);
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("site que bloqueia ou cai: falha honesta, sem criar", async () => {
		const reader: AlertRuleReader = async () => ({ ok: false, code: "http", reason: "o site recusou ou falhou (HTTP 403)", host: "loja.example.com", ms: 4 });
		const { toolResults } = await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", SNEAKER), closing], reader });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toContain("HTTP 403");
		expect(toolResults[0]!.summary).toContain("Do not create the alert with this rule");
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("valor lido que não é número também falha (nada de regra que lê lixo)", async () => {
		const { toolResults } = await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", SNEAKER), closing], reader: reads("Esgotado") });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/não é um número/);
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("campo desconhecido na regra falha listando o que é aceito, sem ler a fonte", async () => {
		const reader = reads("R$ 449,90");
		const bad = { ...SNEAKER, alert: { rule: { ...RULE, headers: { cookie: "x" } } } };
		const { toolResults } = await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", bad), closing], reader });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/unknown field "headers".*accepted: source, check, label, message, intervalMinutes/);
		expect(reader).not.toHaveBeenCalled();
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("o agente escolhe a frequência: abaixo do piso da fonte sobe para 30 min; sem intervalo usa o padrão da fonte; sem o mínimo de 2 h", async () => {
		const every = async (alertRule: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
			vi.mocked(createRoutine).mockClear();
			vi.mocked(createRoutine).mockResolvedValueOnce({ routine: row({ condition: "tênis Nike Pegasus ficar abaixo de R$ 400,00", active: false, rule: RULE }) } as never);
			await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", { ...SNEAKER, ...extra, alert: { rule: alertRule } }), closing], reader: reads("R$ 449,90") });
			return (vi.mocked(createRoutine).mock.calls[0]![1] as { trigger: { everyMinutes: number } }).trigger.everyMinutes;
		};
		expect(await every({ ...RULE, intervalMinutes: 5 })).toBe(30);
		expect(await every({ ...RULE, intervalMinutes: undefined })).toBe(120);
		expect(await every({ ...RULE, intervalMinutes: undefined }, { every_minutes: 60 })).toBe(60);
	});

	it("o limite de 120 min continua valendo para alerta sem regra", async () => {
		const { toolResults } = await run({
			message: "me avisa",
			calls: [toolCall("c1", "propose_routine", { action: "create", title: "Estoque", detail: "check stock", trigger_type: "interval", every_minutes: 30, alert: { condition: "o estoque cair abaixo de 10" } }), closing],
			reader: reads("1"),
		});
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/an interval under 120 minutes/);
	});

	it("limite de 30 alertas ativos volta como erro amigável e acionável", async () => {
		const { AlertLimitError } = await import("@workspace/db");
		vi.mocked(createRoutine).mockRejectedValueOnce(new AlertLimitError());
		const { toolResults } = await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", SNEAKER), closing], reader: reads("R$ 449,90") });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/30 alertas ativos/);
		expect(toolResults[0]!.summary).toMatch(/Pause ou apague/);
	});
});

/** Etapa 2: fontes de mercado, sem link e sem modelo por conferência. Provedores simulados (nada de rede). */
describe("propose_routine com fontes de mercado", () => {
	const numberReader = (value: number, host: string, delayMinutes?: number): AlertRuleReader =>
		vi.fn(async () => ({ ok: true as const, read: { kind: "number" as const, value, ...(delayMinutes !== undefined ? { delayMinutes } : {}) }, host, ms: 4 }));
	const alertRow = (rule: Record<string, unknown>, condition: string, every = 30) => ({ routine: row({ condition, active: false, rule }, every) }) as never;
	const mkRule = (source: Record<string, unknown>, check: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ source, check, ...extra });
	const create = (title: string, rule: Record<string, unknown>) => ({ action: "create", title, detail: "Server-checked market alert.", trigger_type: "interval", alert: { rule } });

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("o esquema ensina as fontes prontas e continua pequeno", () => {
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "propose_routine")!;
		const schema = JSON.stringify(tool.function.parameters);
		for (const word of ["quote", "fx", "crypto", "weather", "rain_probability", "brapi"]) expect(schema).toContain(word);
		expect(JSON.stringify(tool).length).toBeLessThan(26_000);
		expect(groupProcedureText(new Set(["routines"]))).toContain("Ready sources need NO link");
	});

	it("replay: 'me avisa quando BBAS3 cair abaixo de R$ 15' lê a cotação agora e diz o valor e o atraso", async () => {
		const rule = mkRule({ type: "quote", symbol: "BBAS3" }, { kind: "value", parse: "money", op: "lt", value: 15 }, { intervalMinutes: 15 });
		vi.mocked(createRoutine).mockResolvedValueOnce(alertRow({ ...rule, check: { ...rule.check, currency: "BRL" } }, "BBAS3 ficar abaixo de R$ 15,00", 15));
		const reader = numberReader(21.34, "brapi.dev", 30);
		const { toolResults } = await run({ message: "me avisa quando BBAS3 cair abaixo de R$ 15", calls: [toolCall("c1", "propose_routine", create("BBAS3", rule)), closing], reader });
		expect(reader).toHaveBeenCalledTimes(1);
		const created = vi.mocked(createRoutine).mock.calls[0]![1] as { alert: { condition: string; rule: { source: object; check: object } }; trigger: object };
		expect(created.alert.rule.source).toEqual({ type: "quote", symbol: "BBAS3" });
		expect(created.alert.rule.check).toMatchObject({ op: "lt", value: 15, currency: "BRL" });
		expect(created.alert.condition).toBe("BBAS3 ficar abaixo de R$ 15,00");
		expect(created.trigger).toEqual({ kind: "interval", everyMinutes: 15 });
		expect(toolResults[0]).toMatchObject({ ok: true });
		expect(toolResults[0]!.summary).toContain("R$ 21,34 today");
		expect(toolResults[0]!.summary).toContain("delayed (cotação com atraso de ~30 min)");
	});

	it("replay: 'dólar acima de 6' usa câmbio sem chave e diz 1 USD = valor", async () => {
		const rule = mkRule({ type: "fx", pair: "USD-BRL" }, { kind: "value", parse: "money", op: "gt", value: 6 }, { label: "dólar" });
		vi.mocked(createRoutine).mockResolvedValueOnce(alertRow(rule, "dólar passar de R$ 6,00"));
		const { toolResults } = await run({ message: "me avisa se o dólar passar de 6", calls: [toolCall("c1", "propose_routine", create("Dólar", rule)), closing], reader: numberReader(5.97, "economia.awesomeapi.com.br") });
		const created = vi.mocked(createRoutine).mock.calls[0]![1] as { alert: { rule: { check: { currency: string } } }; trigger: { everyMinutes: number } };
		expect(created.alert.rule.check.currency).toBe("BRL");
		expect(created.trigger.everyMinutes).toBe(30);
		expect(toolResults[0]!.summary).toContain("1 USD = R$ 5,97");
	});

	it("replay: 'bitcoin abaixo de 300 mil' usa cripto em BRL com piso de 5 min", async () => {
		const rule = mkRule({ type: "crypto", symbol: "BTC" }, { kind: "value", parse: "money", op: "lt", value: 300000 }, { label: "bitcoin", intervalMinutes: 1 });
		vi.mocked(createRoutine).mockResolvedValueOnce(alertRow({ ...rule, source: { type: "crypto", symbol: "BTC", quote: "BRL" } }, "bitcoin ficar abaixo de R$ 300.000,00", 5));
		const { toolResults } = await run({ message: "avisa se o bitcoin cair abaixo de 300 mil", calls: [toolCall("c1", "propose_routine", create("Bitcoin", rule)), closing], reader: numberReader(351234.5, "api.mercadobitcoin.net") });
		const created = vi.mocked(createRoutine).mock.calls[0]![1] as { alert: { rule: { source: object } }; trigger: { everyMinutes: number } };
		expect(created.alert.rule.source).toEqual({ type: "crypto", symbol: "BTC", quote: "BRL" });
		expect(created.trigger.everyMinutes).toBe(5);
		expect(toolResults[0]).toMatchObject({ ok: true });
	});

	it("replay: 'vai chover amanhã em Curitiba?' vira alerta de previsão com unidade e piso de 3 h", async () => {
		const rule = mkRule({ type: "weather", place: "Curitiba", metric: "rain_probability" }, { kind: "value", parse: "number", op: "gte", value: 60 }, { label: "chuva em Curitiba amanhã", intervalMinutes: 30 });
		vi.mocked(createRoutine).mockResolvedValueOnce(alertRow(rule, "chuva em Curitiba amanhã chegar a 60% ou mais", 180));
		const { toolResults } = await run({ message: "me avisa se for chover amanhã em Curitiba", calls: [toolCall("c1", "propose_routine", create("Chuva em Curitiba", rule)), closing], reader: numberReader(75, "api.open-meteo.com") });
		const created = vi.mocked(createRoutine).mock.calls[0]![1] as { alert: { rule: { source: object } }; trigger: { everyMinutes: number } };
		expect(created.alert.rule.source).toMatchObject({ type: "weather", place: "Curitiba", metric: "rain_probability", day: "tomorrow" });
		expect(created.trigger.everyMinutes).toBe(180);
		expect(toolResults[0]!.summary).toContain("Current forecast: 75%");
	});

	it("cotação sem a chave da brapi falha com a dica de abrir o Marketplace (propose_connector), sem pedir a chave no chat", async () => {
		const reader: AlertRuleReader = async () => ({ ok: false, code: "needs_key", reason: "conecte a brapi no Marketplace (é grátis) para acompanhar cotações", host: "market:quote", ms: 1 });
		const rule = mkRule({ type: "quote", symbol: "BBAS3" }, { kind: "value", parse: "money", op: "lt", value: 15 });
		const { toolResults } = await run({ message: "me avisa se BBAS3 cair", calls: [toolCall("c1", "propose_routine", create("BBAS3", rule)), closing], reader });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toContain("propose_connector");
		expect(toolResults[0]!.summary).toContain("never ask for the key in chat");
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("ticker inválido, cidade desconhecida e campo extra (URL do modelo) falham antes de ler", async () => {
		const reader = numberReader(1, "x");
		for (const source of [{ type: "quote", symbol: "AAPL" }, { type: "quote", symbol: "BBAS3", url: "http://169.254.169.254/" }, { type: "weather", metric: "rain_probability" }]) {
			const { toolResults } = await run({ message: "me avisa", calls: [toolCall("c1", "propose_routine", create("X", mkRule(source, { kind: "value", parse: "number", op: "lt", value: 1 }))), closing], reader });
			expect(toolResults[0]).toMatchObject({ ok: false });
		}
		expect(reader).not.toHaveBeenCalled();
		expect(createRoutine).not.toHaveBeenCalled();
	});
});
