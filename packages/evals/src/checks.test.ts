import { describe, expect, it } from "vitest";
import { evaluateExpectation, firstStepContextTokens, passed, runChecks } from "./checks.js";
import { parseScenario, type Expectation, type Scenario } from "./scenario.js";
import type { RecordedModelCall, Trajectory } from "./trajectory.js";

function scenario(expect: unknown[], extra: Record<string, unknown> = {}): Scenario {
	const parsed = parseScenario({ version: 1, id: "t", title: "t", bot: { name: "Ada" }, user: "oi", expect, ...extra });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.scenario;
}

const main = (tools: string[], messages: unknown[] = []): RecordedModelCall => ({ index: 0, kind: "main", model: "m", messages, tools, durationMs: 1 });

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
	return {
		scenarioId: "t",
		model: "m",
		variant: "base",
		repeat: 0,
		startedAt: "",
		durationMs: 1,
		text: "Pronto.",
		modelCalls: [main(["propose_routine", "create_file"])],
		toolCalls: [],
		toolResults: [],
		events: [],
		visible: [],
		revised: [],
		discards: [],
		steerDelivered: [],
		unmocked: [],
		costUsd: 0,
		costUnknown: false,
		tokens: { prompt: 0, completion: 0 },
		...over,
	};
}

const one = (item: unknown, traj: Trajectory, extra: Record<string, unknown> = {}) => {
	const sc = scenario([item], extra);
	return evaluateExpectation(sc.expect[0] as Exclude<Expectation, { type: "judge" }>, sc, traj);
};

const routineCall = { id: "c1", name: "propose_routine", args: { action: "create", trigger_type: "once" }, argsRaw: "" };

describe("verificações", () => {
	it("tool_called: chamada, argumentos errados, ausente e teto", () => {
		expect(one({ type: "tool_called", tool: "propose_routine", args: { trigger_type: { equals: "once" } } }, trajectory({ toolCalls: [routineCall] })).pass).toBe(true);
		expect(one({ type: "tool_called", tool: "propose_routine", args: { trigger_type: { equals: "cron" } } }, trajectory({ toolCalls: [routineCall] })).detail).toMatch(/argumentos: trigger_type/);
		expect(one({ type: "tool_called", tool: "propose_routine" }, trajectory()).detail).toMatch(/não chamou \(nenhuma tool\)/);
		expect(one({ type: "tool_called", tool: "propose_routine", max: 1 }, trajectory({ toolCalls: [routineCall, { ...routineCall, id: "c2" }] })).detail).toMatch(/2x/);
	});

	it("tool_result confere o que a tool devolveu (o que o motor resolveu), não o que o roteiro pediu (auditoria F4, T1)", () => {
		const result = (summary: string, ok = true) => ({ id: "r", name: "remind_me", ok, summary, source: "real" as const });
		const ten = trajectory({ toolResults: [result("Scheduled reminder ag-1: first run 2026-11-06 10:00 (America/Sao_Paulo).")] });
		const item = { type: "tool_result", tool: "remind_me", pattern: "first run 2026-11-06 10:00 \\(America/Sao_Paulo\\)" };
		expect(one(item, ten).pass).toBe(true);
		// o roteiro pediu 10h mas o motor entendeu 15h: reprova
		expect(one(item, trajectory({ toolResults: [result("Scheduled reminder ag-1: first run 2026-11-06 15:00 (America/Sao_Paulo).")] })).detail).toMatch(/sem \/first run 2026-11-06 10:00/);
		expect(one(item, trajectory()).detail).toMatch(/não devolveu resultado/);
		// ok é verificado (padrão true); max 0 vale como "nenhum resultado assim"
		expect(one(item, trajectory({ toolResults: [result("first run 2026-11-06 10:00 (America/Sao_Paulo)", false)] })).pass).toBe(false);
		const merged = trajectory({ toolResults: [result("Already scheduled (nothing new created): reminder ag-1.")] });
		expect(one({ type: "tool_result", tool: "remind_me", pattern: "Already scheduled", max: 0 }, merged).detail).toMatch(/1 resultados/);
		expect(one({ type: "tool_result", tool: "remind_me", pattern: "Already scheduled", max: 0 }, ten).pass).toBe(true);
		expect(parseScenario({ version: 1, id: "t", title: "t", bot: { name: "Ada" }, user: "oi", expect: [{ type: "tool_result", tool: "x", pattern: "(" }] }).ok).toBe(false);
	});

	it("tool_not_called com padrão", () => {
		const del = { id: "d", name: "mcp__loja__delete_orders", args: {}, argsRaw: "" };
		expect(one({ type: "tool_not_called", toolPattern: "delete" }, trajectory({ toolCalls: [del] })).detail).toBe("chamou mcp__loja__delete_orders");
		expect(one({ type: "tool_not_called", toolPattern: "delete" }, trajectory()).pass).toBe(true);
	});

	it("no_question e asks_question (questionário conta como pergunta)", () => {
		expect(one({ type: "no_question" }, trajectory({ text: "Posso enviar?" })).detail).toBe("terminou com pergunta");
		expect(one({ type: "no_question" }, trajectory({ toolCalls: [{ id: "q", name: "propose_questionnaire", args: {}, argsRaw: "" }] })).detail).toBe("abriu questionário");
		expect(one({ type: "asks_question" }, trajectory({ text: "Apago só os de teste?" })).pass).toBe(true);
		expect(one({ type: "asks_question" }, trajectory({ text: "Apaguei." })).detail).toBe("não perguntou");
		expect(one({ type: "asks_question", max: 1 }, trajectory({ text: "A? B?" })).detail).toMatch(/2 perguntas/);
	});

	it("texto contém / não contém (valor e regex)", () => {
		expect(one({ type: "text_contains", value: "2025" }, trajectory({ text: "Em 2025..." })).pass).toBe(true);
		expect(one({ type: "text_contains", pattern: "43\\s?kg" }, trajectory({ text: "43 kg" })).pass).toBe(true);
		expect(one({ type: "text_contains", value: "ABC", ignoreCase: true }, trajectory({ text: "abc" })).pass).toBe(true);
		expect(one({ type: "text_not_contains", value: "erro" }, trajectory({ text: "deu erro" })).pass).toBe(false);
	});

	it("passos, descartes, idioma e promessa", () => {
		expect(one({ type: "max_model_calls", value: 1 }, trajectory({ modelCalls: [main([]), main([]), { ...main([]), kind: "aux" }] })).detail).toBe("2 passos (máx 1)");
		expect(one({ type: "max_discards", value: 0 }, trajectory({ discards: ["missing_file"] })).detail).toMatch(/missing_file/);
		expect(one({ type: "language", value: "en-US" }, trajectory({ text: "Bom dia! Você pode organizar a semana com uma lista que não acaba." })).detail).toBe("respondeu em pt-BR");
		expect(one({ type: "language", value: "en-US" }, trajectory({ text: "Ok" })).pass).toBe(false);
		expect(one({ type: "no_unfulfilled_promise" }, trajectory({ text: "Vou gerar agora." })).pass).toBe(false);
	});

	it("no_internals usa as tools oferecidas e os balões visíveis", () => {
		expect(one({ type: "no_internals" }, trajectory({ text: "Ok.", visible: ["Chamei create_file."] })).detail).toBe("vazou: create_file");
		expect(one({ type: "no_internals", extraTerms: ["ocean"] }, trajectory({ text: "Paleta Oceano." })).pass).toBe(true);
	});

	it("arquivo criado com extensão", () => {
		const file = { type: "file", filename: "a.pdf" };
		expect(one({ type: "file_created", extension: "pdf" }, trajectory({ events: [file] })).pass).toBe(true);
		expect(one({ type: "file_created", extension: "csv" }, trajectory({ events: [file] })).detail).toMatch(/outra extensão/);
		expect(one({ type: "file_created" }, trajectory()).detail).toBe("nenhum arquivo");
	});

	it("gráfico: spec válido do texto, inválido e predicado", () => {
		const good = "```chart\n" + JSON.stringify({ type: "bar", orientation: "horizontal", x: "p", series: [{ key: "v" }], data: [{ p: "a", v: 1 }] }) + "\n```";
		const bad = "```chart\n" + JSON.stringify({ type: "barh", x: "p", series: [{ key: "v" }], data: [{ p: "a", v: 1 }] }) + "\n```";
		const spec = { orientation: { equals: "horizontal" } };
		expect(one({ type: "chart", spec }, trajectory({ text: good })).pass).toBe(true);
		expect(one({ type: "chart", spec }, trajectory({ text: bad })).detail).toMatch(/gráfico inválido/);
		expect(one({ type: "chart", spec: { orientation: { equals: "vertical" } } }, trajectory({ text: good })).detail).toMatch(/spec: orientation/);
		expect(one({ type: "chart" }, trajectory()).detail).toBe("nenhum gráfico");
		expect(one({ type: "chart" }, trajectory({ events: [{ type: "chart", spec: { type: "line" } }] })).pass).toBe(true);
	});

	it("nota do runtime nas mensagens de sistema/tool, não na fala do usuário", () => {
		const calls = [main([], [{ role: "user", content: "did NOT see" }, { role: "system", content: "ok" }])];
		expect(one({ type: "no_model_note", pattern: "did NOT see" }, trajectory({ modelCalls: calls })).pass).toBe(true);
		const noted = [main([], [{ role: "tool", content: "Note: the user did NOT see it" }])];
		expect(one({ type: "no_model_note", pattern: "did NOT see" }, trajectory({ modelCalls: noted })).pass).toBe(false);
	});

	it("mensagem do meio do run entregue ao modelo", () => {
		const extra = { steer: [{ afterModelCalls: 1, content: "inclui 2025" }] };
		const delivered = [main([], [{ role: "user", content: "[mensagem do usuário] inclui 2025" }])];
		expect(one({ type: "steer_delivered" }, trajectory({ modelCalls: delivered }), extra).pass).toBe(true);
		expect(one({ type: "steer_delivered" }, trajectory(), extra).pass).toBe(false);
	});

	it("any_of: passa se qualquer verificação aninhada passa; a falha lista o motivo de todas", () => {
		const item = {
			type: "any_of",
			checks: [
				{ type: "tool_called", tool: "propose_routine", args: { run_at: { matches: "T10:00" } } },
				{ type: "tool_called", tool: "schedule_followup", args: { when: { matches: "10" } } },
			],
		};
		const followup = { id: "f1", name: "schedule_followup", args: { when: "amanhã 10h" }, argsRaw: "" };
		expect(one(item, trajectory({ toolCalls: [followup] })).pass).toBe(true);
		expect(one(item, trajectory({ toolCalls: [{ ...routineCall, args: { run_at: "2026-11-06T10:00" } }] })).pass).toBe(true);
		const wrong = one(item, trajectory({ toolCalls: [{ ...routineCall, args: { run_at: "2026-11-06T15:00" } }] }));
		expect(wrong.pass).toBe(false);
		expect(wrong.detail).toMatch(/nenhuma passou: tool_called:propose_routine \(argumentos: run_at.*\| tool_called:schedule_followup \(não chamou/);
	});

	it("max_context_tokens: estimativa do 1º passo (mensagens + schemas das tools), chars / 4", () => {
		const first = { ...main(["a"], [{ role: "user", content: "x".repeat(400) }]), toolsChars: 600 };
		const tokens = firstStepContextTokens({ modelCalls: [first] });
		expect(tokens).toBe(Math.ceil((JSON.stringify(first.messages).length + 600) / 4));
		expect(one({ type: "max_context_tokens", value: tokens! }, trajectory({ modelCalls: [first] })).pass).toBe(true);
		expect(one({ type: "max_context_tokens", value: tokens! - 1 }, trajectory({ modelCalls: [first] })).detail).toMatch(/contexto do 1º passo ~\d+ tokens \(máx \d+\)/);
		// só o 1º passo conta: um passo seguinte maior não reprova
		const later = { ...main(["a"], [{ role: "user", content: "y".repeat(4000) }]), index: 1, toolsChars: 0 };
		expect(one({ type: "max_context_tokens", value: tokens! }, trajectory({ modelCalls: [first, later] })).pass).toBe(true);
		expect(one({ type: "max_context_tokens", value: 10 }, trajectory({ modelCalls: [] })).detail).toBe("nenhum passo do agente");
	});

	it("padrões negativos do conjunto ouro: 'vídeo' (com acento ou sem) e oferta de continuar", () => {
		const noVideo = { type: "text_not_contains", pattern: "v[ií]deo|youtube|legenda", ignoreCase: true };
		expect(one(noVideo, trajectory({ text: "Amanhã faz 22 °C em Curitiba." })).pass).toBe(true);
		expect(one(noVideo, trajectory({ text: "Amanhã 22 °C. Quer voltar ao resumo do VÍDEO?" })).pass).toBe(false);
		expect(one(noVideo, trajectory({ text: "Sobre o YouTube: não deu." })).pass).toBe(false);
		const noOffer = { type: "text_not_contains", pattern: "quer que eu (continue|tente|retome)|posso (tentar|continuar|retomar)", ignoreCase: true };
		expect(one(noOffer, trajectory({ text: "Quer que eu continue de onde parei?" })).pass).toBe(false);
		const noPurchaseClaim = { type: "text_not_contains", pattern: "(?<!n[aã]o )comprei", ignoreCase: true };
		expect(one(noPurchaseClaim, trajectory({ text: "Não comprei nada." })).pass).toBe(true);
		expect(one(noPurchaseClaim, trajectory({ text: "Comprei o kit." })).pass).toBe(false);
	});

	it("erro do run falha 'completed' mesmo sem ele declarado; juiz desligado é pulado", async () => {
		const sc = scenario([{ type: "no_question" }, { type: "judge", rubric: "A resposta resolve o pedido." }]);
		const results = await runChecks(sc, trajectory({ error: "tempo esgotado", text: "" }));
		expect(results.map((item) => [item.name, item.pass, item.skipped ?? false])).toEqual([
			["completed", false, false],
			["no_question", true, false],
			["judge", true, true],
		]);
		expect(passed(results)).toBe(false);
	});

	it("juiz injetado decide; falha do juiz reprova com o motivo", async () => {
		const sc = scenario([{ type: "judge", rubric: "A resposta resolve o pedido." }]);
		expect(await runChecks(sc, trajectory(), { judge: async () => ({ pass: false, reason: "incompleta" }) })).toEqual([{ name: "judge", pass: false, detail: "incompleta" }]);
		const broken = await runChecks(sc, trajectory(), {
			judge: async () => {
				throw new Error("timeout");
			},
		});
		expect(broken[0]).toMatchObject({ pass: false, detail: "juiz falhou: timeout" });
	});
});
