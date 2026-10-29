import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createRoutine, listRoutines, updateRoutine } from "@workspace/db";
import { SYSTEM_PROMPT, runComputerUse } from "./computer-use.js";
import { getGithubConnectionToken } from "./mcp/github-token.js";
import { listUserRepos } from "./github/client.js";

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
		deleteRoutine: vi.fn(async () => true),
	};
});

vi.mock("./mcp/github-token.js", () => ({
	getGithubConnectionToken: vi.fn(),
	markGithubConnectionAuthFailed: vi.fn(async () => undefined),
}));

vi.mock("./github/client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./github/client.js")>();
	return { ...actual, listUserRepos: vi.fn() };
});

vi.mock("./github/hook-sync.js", () => ({
	ensureGithubRepoHook: vi.fn(async () => ({ ok: true })),
}));

function toolCall(id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		},
	};
}

function fakeIntervalRoutine(everyMinutes = 50) {
	return {
		id: "routine-int-1",
		userId: "user-real",
		botId: "bot-1",
		conversationId: null,
		name: "Monitorar loja exemplo",
		prompt: "Revise o repositório.",
		model: "",
		enabled: true,
		triggerType: "interval" as const,
		schedule: null,
		timezone: "America/Sao_Paulo",
		lastRunAt: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		interval: { everyMinutes },
	};
}

async function run(userText: string, calls: CompleteChatWithToolsResult[]) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const routines: Array<{ action: string; triggerType?: string; detail?: string }> = [];
	const queue = [...calls, { model: "test-model", message: { role: "assistant" as const, content: "ok" } }];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "session-int",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: userText }],
		runId: "run-interval",
		conversationId: "conv-interval",
		botId: "bot-1",
		userId: "user-real",
		maxSteps: 6,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
			if (event.type === "routine") routines.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults, routines };
}

describe("propose_routine trigger_type=interval", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("create: guarda { kind: 'interval', everyMinutes: 50 } e emite o card com o resumo", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: fakeIntervalRoutine() } as never);
		const { toolResults, routines } = await run("revisa o repo a cada 50 minutos", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "Monitorar loja exemplo",
				detail: "Revise o repositório.",
				trigger_type: "interval",
				every_minutes: 50,
			}),
		]);
		expect(createRoutine).toHaveBeenCalledWith(
			"user-real",
			expect.objectContaining({
				triggerType: "interval",
				trigger: { kind: "interval", everyMinutes: 50 },
			}),
		);
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toContain("A cada 50 min");
		expect(routines[0]).toEqual(
			expect.objectContaining({ action: "created", triggerType: "interval" }),
		);
		expect(routines[0]?.detail).toContain("A cada 50 min");
	});

	it.each([4, 1441, "abc"])("create com every_minutes=%s falha (ok:false) e não cria", async (bad) => {
		const { toolResults, routines } = await run("a cada X", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "X",
				detail: "Faça algo.",
				trigger_type: "interval",
				every_minutes: bad,
			}),
		]);
		expect(createRoutine).not.toHaveBeenCalled();
		expect(routines).toHaveLength(0);
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toMatch(/every_minutes|intervalo/);
	});

	it("create sem every_minutes falha com dica acionável", async () => {
		const { toolResults } = await run("a cada X", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "X",
				detail: "Faça algo.",
				trigger_type: "interval",
			}),
		]);
		expect(createRoutine).not.toHaveBeenCalled();
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toMatch(/every_minutes/);
	});

	it("edit: troca every_minutes de uma rotina interval (sem card)", async () => {
		const existing = fakeIntervalRoutine(50);
		vi.mocked(listRoutines).mockResolvedValue([existing] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce(fakeIntervalRoutine(120) as never);
		const { toolResults, routines } = await run("muda pra cada 2 horas", [
			toolCall("c1", "propose_routine", {
				action: "edit",
				target: "routine-int-1",
				detail: "Revise o repositório.",
				trigger_type: "interval",
				every_minutes: 120,
			}),
		]);
		expect(updateRoutine).toHaveBeenCalledWith(
			"user-real",
			"bot-1",
			"routine-int-1",
			expect.objectContaining({
				triggerType: "interval",
				schedule: null,
				intervalTrigger: { everyMinutes: 120 },
			}),
		);
		expect(toolResults[0]?.summary).toContain("A cada 2 h");
		expect(routines).toContainEqual(expect.objectContaining({ action: "updated" }));
	});

	it("edit sem every_minutes mantém o intervalo atual", async () => {
		vi.mocked(listRoutines).mockResolvedValue([fakeIntervalRoutine(50)] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce(fakeIntervalRoutine(50) as never);
		await run("muda o texto da rotina", [
			toolCall("c1", "propose_routine", {
				action: "edit",
				target: "routine-int-1",
				detail: "Novo texto.",
				trigger_type: "interval",
			}),
		]);
		expect(updateRoutine).toHaveBeenCalledWith(
			"user-real",
			"bot-1",
			"routine-int-1",
			expect.objectContaining({ intervalTrigger: { everyMinutes: 50 } }),
		);
	});

	it("list_routines mostra o resumo em frase, não cron", async () => {
		vi.mocked(listRoutines).mockResolvedValue([fakeIntervalRoutine(50)] as never);
		const { toolResults } = await run("minhas rotinas", [toolCall("c1", "list_routines", {})]);
		expect(toolResults[0]?.summary).toContain("A cada 50 min");
		expect(toolResults[0]?.summary).not.toMatch(/cron/);
	});
});

describe("prompt: GitHub aceita intervalo (F3)", () => {
	it("SYSTEM_PROMPT não proíbe mais frequência e traz a regra webhook x interval", () => {
		expect(SYSTEM_PROMPT).not.toContain("NUNCA pergunte frequência");
		expect(SYSTEM_PROMPT).not.toContain("NÃO tem 'de tempos em tempos'");
		expect(SYSTEM_PROMPT).toContain("trigger_type `interval` with every_minutes");
		expect(SYSTEM_PROMPT).toContain("Instant event (push, PR opened, merge, CI, review) -> trigger_type `github`");
		expect(SYSTEM_PROMPT).toContain("Both together are fine");
		expect(SYSTEM_PROMPT).toContain("never refuse a frequency");
	});

	it("SYSTEM_PROMPT manda criar recursos pelo conector, não pelo navegador (nota da F2)", () => {
		expect(SYSTEM_PROMPT).toContain("through the connector, never through the sandbox browser");
	});

	it("a descrição do propose_routine oferece interval e não proíbe intervalo no GitHub", async () => {
		let description = "";
		let triggerTypeEnum: string[] = [];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-int",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "me lembra amanhã de revisar" }],
			runId: "run-desc",
			conversationId: "conv-desc",
			botId: "bot-1",
			userId: "user-real",
			maxSteps: 2,
			onEvent: () => undefined,
			streamChat: async (params) => {
				const tool = params.tools.find((t) => t.function.name === "propose_routine");
				description = tool?.function.description ?? "";
				const props = (tool?.function.parameters as { properties: Record<string, { enum?: string[] }> })
					.properties;
				triggerTypeEnum = props.trigger_type?.enum ?? [];
				return { model: "test-model", message: { role: "assistant", content: "ok" } };
			},
		});
		expect(triggerTypeEnum).toContain("interval");
		expect(description).toContain("every_minutes");
		expect(description).not.toMatch(/NUNCA pergunte frequ/);
		expect(description).not.toContain("GitHub é webhook instantâneo");
	});
});

describe("replay: monitorar o loja monorepo a cada 50 minutos com nota de segurança", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("resolve o repo e cria rotina interval de 50 min, sem recusar nem questionário", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ token: "t", source: "pat" });
		vi.mocked(listUserRepos).mockResolvedValue({
			data: [
				{ fullName: "acme/loja-monorepo", private: true, defaultBranch: "main", pushedAt: "2026-09-28T00:00:00Z" },
			],
		});
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: fakeIntervalRoutine() } as never);
		const { toolResults, routines } = await run(
			"monitore todas as entradas do loja monorepo (git, PR, merge) e valide se é seguro de 0 a 10, a cada 50 minutos",
			[
				toolCall("c1", "github_list_repos", { query: "loja" }),
				toolCall("c2", "propose_routine", {
					action: "create",
					title: "Segurança loja exemplo",
					detail: "Revise commits e PRs novos e dê nota de segurança de 0 a 10.",
					trigger_type: "interval",
					every_minutes: 50,
				}),
			],
		);
		expect(toolResults.map((r) => r.name)).toEqual(["github_list_repos", "propose_routine"]);
		expect(toolResults.every((r) => r.ok)).toBe(true);
		expect(createRoutine).toHaveBeenCalledWith(
			"user-real",
			expect.objectContaining({ trigger: { kind: "interval", everyMinutes: 50 } }),
		);
		expect(routines[0]).toEqual(expect.objectContaining({ action: "created", triggerType: "interval" }));
		expect(toolResults.some((r) => r.name === "propose_questionnaire")).toBe(false);
	});
});

describe("propose_routine template=github_security_review", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("monta o prompt da revisão 0-10 com o repo e cria a rotina interval", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: fakeIntervalRoutine() } as never);
		const { toolResults } = await run("revisão de segurança do monorepo a cada 50 min", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "Segurança loja exemplo",
				template: "github_security_review",
				repo: "https://github.com/acme/loja-monorepo",
				trigger_type: "interval",
				every_minutes: 50,
			}),
		]);
		expect(toolResults[0]?.ok).toBe(true);
		const input = vi.mocked(createRoutine).mock.calls[0]?.[1] as { prompt: string };
		expect(input.prompt).toContain("acme/loja-monorepo");
		expect(input.prompt).toContain("Nota X/10");
		expect(input.prompt).toContain("pull_request_read");
	});

	it("sem repo válido falha (ok:false) e não cria", async () => {
		const { toolResults } = await run("revisão, crie uma rotina", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "Segurança",
				template: "github_security_review",
				trigger_type: "interval",
				every_minutes: 50,
			}),
		]);
		expect(createRoutine).not.toHaveBeenCalled();
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toMatch(/owner\/name/);
	});

	it("template desconhecido falha", async () => {
		const { toolResults } = await run("crie uma rotina x", [
			toolCall("c1", "propose_routine", {
				action: "create",
				title: "X",
				detail: "d",
				template: "outro",
				trigger_type: "interval",
				every_minutes: 50,
			}),
		]);
		expect(toolResults[0]?.ok).toBe(false);
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("SYSTEM_PROMPT ensina o template de revisão de segurança", () => {
		expect(SYSTEM_PROMPT).toContain("template=github_security_review");
	});
});
