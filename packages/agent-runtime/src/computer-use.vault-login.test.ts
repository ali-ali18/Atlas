import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { memoryVaultStore } from "./secrets/memory-store.js";
import { setVaultServiceForTests, VaultService } from "./secrets/vault-service.js";
import { sealSecrets } from "./secrets/secret-box.js";
import type { McpRuntime } from "./mcp/runtime.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: async () => [],
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
}));

const PASSWORD = "Sup3rSenha!XYZ";
const step = (name: string, args: Record<string, unknown> = {}): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const text = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const wallSnapshot = (url: string) => ({
	url,
	title: "Entrar",
	total: 2,
	offset: 0,
	limit: 80,
	nextOffset: null,
	lines: ['[e1] textbox "E-mail"', '[e2] textbox "Senha" (campo de senha: nunca preencha)'],
});

let vault: VaultService;

beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(() => {
	vault = new VaultService(memoryVaultStore());
	setVaultServiceForTests(vault);
});

async function addChatgpt() {
	await vault.create("user-a", { kind: "login", name: "chatgpt", label: "ChatGPT", siteUrl: "https://chatgpt.com", username: "alice@x.com", payload: { password: PASSWORD } });
}

async function run(opts: {
	queue: CompleteChatWithToolsResult[];
	url?: string;
	restored?: AgentRunCheckpoint | null;
	pageAfter?: { url: string; title: string; text: string };
	typeFails?: (selector: string) => boolean;
	emailTimeoutMs?: number;
	pageFor?: (typed: string[]) => { url: string; title: string; text: string };
	/** Snapshot devolvido depois que o runtime digitou (quantos campos já foram digitados). */
	snapshotAfterTyping?: (typedCount: number) => ReturnType<typeof wallSnapshot>;
	/** Tela vista quando o run é retomado por "Terminei" (padrão: já logado). */
	snapshotOnResume?: () => ReturnType<typeof wallSnapshot>;
	recentLoginAsks?: { asked?: string[]; vaultTried?: string[] };
	recentLoginAsksSpy?: ReturnType<typeof vi.fn>;
	mcp?: McpRuntime;
	origin?: string;
	userId?: string;
	/** Mensagens do dono esperando no run (inputs ainda não consumidos). */
	steer?: Array<{ id: string; content: string; mode?: string }>;
	messages?: Array<{ role: "user" | "assistant"; content: string }>;
}) {
	const events: Array<Record<string, unknown>> = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const seen: string[] = [];
	const requests: Array<{ tools: string[]; system: string; last?: string[] }> = [];
	const onLoginRequired = vi.fn(async () => undefined);
	const execBrowserType = vi.fn(async (_s: string, p: { selector: string }) => (opts.typeFails?.(p.selector) ? { ok: false } : { ok: true }));
	const execBrowserSnapshot = vi.fn(async () => {
		if (opts.restored && execBrowserType.mock.calls.length === 0) return (opts.snapshotOnResume ?? homeSnapshot)();
		return opts.snapshotAfterTyping && execBrowserType.mock.calls.length > 0 ? opts.snapshotAfterTyping(execBrowserType.mock.calls.length) : wallSnapshot(opts.url ?? "https://chatgpt.com/auth/login");
	});
	const execBrowserText = vi.fn(async () => (opts.pageFor ? opts.pageFor(execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text)) : null) ?? (execBrowserType.mock.calls.length === 0 ? { url: opts.url ?? "https://chatgpt.com/auth/login", title: "Entrar", text: "", totalLength: 0 } : opts.pageAfter) ?? { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?", totalLength: 24 });
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	const error = await runComputerUse({
		manager: { execBrowserSnapshot, execBrowserType, execBrowserText } as unknown as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: true,
		model: "m",
		apiKey: "test",
		userId: opts.userId ?? "user-a",
		botId: "bot-1",
		origin: (opts.origin ?? "chat") as "chat",
		messages: opts.messages ?? [{ role: "user", content: "Faz login no chatgpt pra mim pfv" }],
		...(opts.steer ? { consumeSteerInputs: async () => opts.steer! } : {}),
		runId: "run-vl",
		conversationId: "conv-1",
		maxSteps: 10,
		vaultLoginSettleMs: 0,
		vaultEmailTimeoutMs: opts.emailTimeoutMs ?? 0,
		mcp: opts.mcp,
		restoredCheckpoint: opts.restored ?? null,
		onLoginRequired,
		...(opts.recentLoginAsks || opts.recentLoginAsksSpy ? { recentLoginAsks: async () => { opts.recentLoginAsksSpy?.(); return { asked: opts.recentLoginAsks?.asked ?? [], vaultTried: opts.recentLoginAsks?.vaultTried ?? [] }; } } : {}),
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(checkpoint);
		},
		onEvent: (event) => {
			events.push(event as unknown as Record<string, unknown>);
		},
		streamChat: async (request) => {
			for (const message of request.messages) if (typeof message.content === "string") seen.push(message.content);
			requests.push({
				last: request.messages.slice(-4).map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 160) : JSON.stringify(m.content).slice(0, 160)}${m.tool_calls ? "TC" + m.tool_calls.map((c) => c.function.name).join(",") : ""}`),
				tools: (request.tools ?? []).map((tool) => tool.function.name),
				system: typeof request.messages[0]?.content === "string" ? request.messages[0].content : "",
			});
			return opts.queue.shift() ?? text("fim");
		},
	} as Parameters<typeof runComputerUse>[0]).then((value) => {
		result = value;
		return undefined;
	}, (e: unknown) => e);
	return { error, events, checkpoints, seen, requests, onLoginRequired, execBrowserType, execBrowserSnapshot, result };
}

const CODE = "482913";
const emailStepPage = { url: "https://auth.openai.com/email-verification", title: "Verifique seu e-mail", text: "Enviamos um código de verificação para alice@x.com", totalLength: 50 };
const homePage = { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?", totalLength: 24 };
const loginPage = { url: "https://chatgpt.com/auth/login", title: "Entrar", text: "", totalLength: 0 };
const pagesFor = (typed: string[]) => (typed.includes(CODE) ? homePage : typed.length >= 2 ? emailStepPage : loginPage);

function gmailMcp(messages: Array<{ from: string; subject: string; ageMs: number }>) {
	const entry = (toolName: string, readOnly: boolean) => ({ connectionId: "c1", connectionName: "Gmail", toolName, readOnly, actionClass: "read" as const, autonomyMeta: { actionClass: "read" as const, tool: toolName }, requiresConfirmation: false });
	const call = vi.fn(async () => ({
		ok: true,
		truncated: false,
		text: messages.map((m, i) => [`id: m${i}`, `de: ${m.from}`, `assunto: ${m.subject}`, `data: ${new Date(Date.now() - m.ageMs).toUTCString()}`, `resumo: ${m.subject}`].join("\n")).join("\n\n"),
	}));
	const mcp = {
		toolset: {
			tools: [], omitted: [], index: [], connectorNames: ["Gmail"], deferred: false,
			entries: new Map([["mcp__gmail__search_messages", entry("search_messages", true)]]),
			available: new Map([["mcp__gmail__search_messages", { type: "function", function: { name: "mcp__gmail__search_messages", description: "", parameters: { type: "object", properties: { query: { type: "string" } } } } }]]),
		},
		call,
	} as unknown as McpRuntime;
	return { mcp, call };
}

const homeSnapshot = () => ({ url: "https://chatgpt.com/", title: "ChatGPT", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['[e1] textbox "Pergunte qualquer coisa"'] });

/** Run parado num cartão de login (sem cofre casando) com a oferta do Cofre injetada no checkpoint: caminho "Entrar". */
async function pausedWithOffer(mcp?: McpRuntime) {
	const first = await run({ queue: [step("browser_snapshot")], mcp, userId: "user-sem-cofre" });
	const checkpoint = structuredClone(first.checkpoints.at(-1)!);
	checkpoint.pendingLogin!.vault = { name: "chatgpt", label: "ChatGPT", username: "alice@x.com", domain: "chatgpt.com" };
	return { first, checkpoint };
}

describe("Cofre automático no muro de login", () => {
	it("com login casando no cofre: entra sozinho, sem cartão de aprovação, e deixa só a linha discreta", async () => {
		await addChatgpt();
		const { error, events, seen, execBrowserType, onLoginRequired, checkpoints } = await run({
			queue: [step("browser_snapshot"), text("Pronto, entrei.")],
			snapshotAfterTyping: homeSnapshot,
			pageAfter: homePage,
		});
		expect(error).not.toBeInstanceOf(Error);
		expect(execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text)).toEqual(["alice@x.com", PASSWORD]);
		expect(events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
		expect(events.filter((e) => e.type === "confirm")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(events.find((e) => e.type === "login" && e.status === "done")).toMatchObject({ site: "chatgpt.com", vault: { name: "chatgpt", domain: "chatgpt.com" } });
		expect(seen.some((m) => m.includes("[login-vault-filled]"))).toBe(true);
		expect(JSON.stringify([events, seen, checkpoints])).not.toContain(PASSWORD);
		expect(checkpoints.at(-1)?.pendingLogin).toBeUndefined();
	});

	it("'Entrar': o runtime preenche usuário e senha (login_fill) e o fluxo segue sem 2º card", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		checkpoint.pendingLogin!.useVault = true;
		const second = await run({ queue: [text("Pronto, entrei.")], restored: checkpoint });
		expect(second.error).not.toBeInstanceOf(Error);
		const typed = second.execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text);
		expect(typed).toEqual(["alice@x.com", PASSWORD]);
		expect(second.seen.some((m) => m.includes("[login-vault-filled]"))).toBe(true);
		expect(JSON.stringify(second.seen)).not.toContain(PASSWORD);
		expect(second.events.some((e) => e.type === "login" && e.status === "done")).toBe(true);
		expect(second.events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
	});

	it("sem 'Entrar' (Terminei / Eu faço): nada é digitado pelo runtime", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		const second = await run({ queue: [text("ok")], restored: checkpoint });
		expect(second.execBrowserType).not.toHaveBeenCalled();
		expect(second.seen.some((m) => m.includes("[login-complete]"))).toBe(true);
	});

	it("passo extra humano (passkey/captcha) depois do login: cai no cartão humano explicando o que falta", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		checkpoint.pendingLogin!.useVault = true;
		const second = await run({
			queue: [text("não deve chegar")],
			restored: checkpoint,
			pageAfter: { url: "https://auth.openai.com/passkey", title: "Confirme que é você", text: "Use sua chave de acesso (passkey) para continuar" },
		});
		expect(second.error).toMatchObject({ name: "AgentRunPausedError" });
		const human = second.events.find((e) => e.type === "login" && e.status === "pending");
		expect(human).toMatchObject({ site: "chatgpt.com", loginId: expect.stringMatching(/-h$/) });
		expect(String(human?.vaultTried)).toMatch(/mais um passo|mudou de site/);
		expect(human?.vault).toBeUndefined();
		expect(second.onLoginRequired).toHaveBeenCalledTimes(1);
		expect(second.checkpoints.at(-1)?.pendingLogin?.vaultTried).toBeTruthy();
		expect(second.checkpoints.at(-1)?.pendingLogin?.useVault).toBeUndefined();
	});

	it("entrada em duas telas: usuário primeiro, senha na tela seguinte", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		checkpoint.pendingLogin!.useVault = true;
		let passwordTries = 0;
		const second = await run({
			queue: [text("ok")],
			restored: checkpoint,
			typeFails: (selector) => selector.includes('type="password"') && passwordTries++ === 0,
		});
		expect(second.error).not.toBeInstanceOf(Error);
		const typed = second.execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text);
		// 1ª tentativa (usuário + senha) falha no campo de senha; envia o usuário e preenche a senha na tela seguinte
		expect(typed).toEqual(["alice@x.com", PASSWORD, "alice@x.com", PASSWORD]);
	});

	it("sem login no cofre, ou domínio que não casa: card humano comum, sem oferta", async () => {
		const empty = await run({ queue: [step("browser_snapshot")] });
		expect(empty.events.find((e) => e.type === "login")).toMatchObject({ site: "chatgpt.com" });
		expect(empty.events.find((e) => e.type === "login")?.vault).toBeUndefined();
		await vault.create("user-a", { kind: "login", name: "github", label: "GitHub", siteUrl: "https://github.com/login", username: "a@x.com", payload: { password: PASSWORD } });
		const other = await run({ queue: [step("browser_snapshot")] });
		expect(other.events.find((e) => e.type === "login")?.vault).toBeUndefined();
		expect(other.checkpoints.at(-1)?.pendingLogin?.vault).toBeUndefined();
	});

	it("domínio parecido (phishing) não casa com o login do cofre", async () => {
		await addChatgpt();
		const { events } = await run({ queue: [step("browser_snapshot")], url: "https://chatgpt.com.evil.example/login" });
		expect(events.find((e) => e.type === "login")?.vault).toBeUndefined();
	});

	it("com logins no cofre, login_fill vem carregado e o prompt lista só os domínios", async () => {
		await addChatgpt();
		const { requests } = await run({ queue: [text("ok")] });
		expect(requests[0]!.tools).toEqual(expect.arrayContaining(["login_fill", "secret_list"]));
		expect(requests[0]!.system).toContain("chatgpt.com");
		expect(requests[0]!.system).not.toContain("alice@x.com");
		setVaultServiceForTests(new VaultService(memoryVaultStore()));
		const bare = await run({ queue: [text("ok")] });
		expect(bare.requests[0]!.system).not.toContain("Saved site logins");
	});
});

describe("código de login enviado por e-mail", () => {
	const typedOf = (r: { execBrowserType: { mock: { calls: unknown[][] } } }) => r.execBrowserType.mock.calls.map((c) => (c[1] as { text: string }).text);

	it("código achado no e-mail e digitado pelo runtime; o modelo e o transcript nunca o veem", async () => {
		await addChatgpt();
		const gmail = gmailMcp([{ from: "ChatGPT <noreply@tm.openai.com>", subject: `Your ChatGPT code is ${CODE}`, ageMs: 2000 }]);
		const { checkpoint } = await pausedWithOffer(gmail.mcp);
		checkpoint.pendingLogin!.useVault = true;
		const second = await run({ queue: [text("Pronto.")], restored: checkpoint, mcp: gmail.mcp, pageFor: pagesFor });
		expect(second.error).not.toBeInstanceOf(Error);
		expect(typedOf(second)).toEqual(["alice@x.com", PASSWORD, CODE]);
		expect(second.seen.some((m) => m.includes("[login-email-code-filled]"))).toBe(true);
		const transcript = JSON.stringify([second.seen, second.events]);
		expect(transcript).not.toContain(CODE);
		expect(transcript).not.toContain(PASSWORD);
		expect(second.events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
		// só leitura: a única chamada ao conector foi a busca
		expect(gmail.call.mock.calls.every((c) => String(c[0]).includes("search_messages"))).toBe(true);
	});

	it("e-mail de outro remetente ou antigo é ignorado: cai no cartão com campo de código", async () => {
		await addChatgpt();
		const gmail = gmailMcp([
			{ from: "Golpe <alerta@evil.example>", subject: "Your code is 111111", ageMs: 1000 },
			{ from: "ChatGPT <noreply@tm.openai.com>", subject: `Your ChatGPT code is ${CODE}`, ageMs: 3_600_000 },
		]);
		const { checkpoint } = await pausedWithOffer(gmail.mcp);
		checkpoint.pendingLogin!.useVault = true;
		const second = await run({ queue: [text("x")], restored: checkpoint, mcp: gmail.mcp, pageFor: pagesFor, emailTimeoutMs: 0 });
		expect(second.error).toMatchObject({ name: "AgentRunPausedError" });
		expect(typedOf(second)).not.toContain("111111");
		expect(typedOf(second)).not.toContain(CODE);
		const card = second.events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ codeField: true });
	});

	it("sem conector de e-mail: cartão com campo de código; o código digitado vai direto à página", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		checkpoint.pendingLogin!.useVault = true;
		const second = await run({ queue: [text("x")], restored: checkpoint, pageFor: pagesFor });
		expect(second.error).toMatchObject({ name: "AgentRunPausedError" });
		const card = second.events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ codeField: true });
		expect(String(card?.vaultTried)).toContain("Digite o código");
		const paused = structuredClone(second.checkpoints.at(-1)!);
		expect(paused.pendingLogin?.codeField).toBe(true);
		// o card manda o código; a API o sela no checkpoint
		paused.pendingLogin!.codeEnc = sealSecrets({ code: CODE });
		const third = await run({ queue: [text("Pronto, entrei.")], restored: paused, pageFor: (typed) => (typed.includes(CODE) ? homePage : emailStepPage) });
		expect(third.error).not.toBeInstanceOf(Error);
		expect(typedOf(third)).toEqual([CODE]);
		expect(third.seen.some((m) => m.includes("[login-email-code-filled]"))).toBe(true);
		expect(JSON.stringify([third.seen, third.events, third.checkpoints])).not.toContain(CODE);
	});
});

describe("Cofre primeiro: login salvo do dono entra sozinho, antes do card", () => {
	it("tela some depois de preencher: sem card, o modelo recebe a confirmação e a senha nunca aparece", async () => {
		await addChatgpt();
		const { error, events, seen, execBrowserType, onLoginRequired } = await run({
			queue: [step("browser_snapshot"), text("Pronto, entrei.")],
			snapshotAfterTyping: homeSnapshot,
			pageAfter: { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?" },
		});
		expect(error).not.toBeInstanceOf(Error);
		expect(execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text)).toEqual(["alice@x.com", PASSWORD]);
		expect(events.filter((e) => e.type === "login" && e.status !== "done")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(seen.some((m) => m.includes("[login-vault-filled]") && m.includes("browser_snapshot"))).toBe(true);
		expect(seen.some((m) => m.includes("LOGIN REQUIRED"))).toBe(false);
		expect(JSON.stringify([events, seen])).not.toContain(PASSWORD);
	});

	it("a tela de login continua (senha errada/2FA): card humano explicando, sem a oferta do Cofre", async () => {
		await addChatgpt();
		const { error, events, onLoginRequired, checkpoints } = await run({ queue: [step("browser_snapshot")] });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		const card = events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ site: "chatgpt.com" });
		expect(String(card?.vaultTried)).toContain("mais um passo");
		expect(card?.vault).toBeUndefined();
		expect(onLoginRequired).toHaveBeenCalledTimes(1);
		expect(checkpoints.at(-1)?.pendingLogin?.vaultTried).toBeTruthy();
	});

	it("subdomínio do site salvo casa pelo domínio registrável (painel.chatgpt.com usa o login de chatgpt.com)", async () => {
		await addChatgpt();
		const { events, execBrowserType } = await run({
			queue: [step("browser_snapshot"), text("ok")],
			url: "https://painel.chatgpt.com/entrar",
			snapshotAfterTyping: () => ({ ...homeSnapshot(), url: "https://painel.chatgpt.com/" }),
			pageAfter: { url: "https://painel.chatgpt.com/", title: "Painel", text: "Bem-vindo" },
		});
		expect(execBrowserType).toHaveBeenCalled();
		expect(events.filter((e) => e.type === "login" && e.status !== "done")).toHaveLength(0);
	});

	it("sem login salvo para o site: card comum 'faça você mesmo', nada digitado", async () => {
		const { events, execBrowserType } = await run({ queue: [step("browser_snapshot")] });
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(events.find((e) => e.type === "login" && e.status === "pending")?.vault).toBeUndefined();
	});
});

describe("Terminei confere a tela e o aviso de login vale por conversa", () => {
	it("Terminei, mas a tela de login continua: avisa em português e não segue às cegas", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		const second = await run({ queue: [text("não deve chegar")], restored: checkpoint, snapshotOnResume: () => wallSnapshot("https://chatgpt.com/auth/login") });
		expect(second.error).toBeUndefined();
		expect(second.result?.text).toContain("Ainda vejo a tela de login de chatgpt.com");
		expect(second.result?.text).not.toMatch(/browser_snapshot|login-complete|runtime/i);
		expect(second.seen.some((m) => m.includes("[login-complete]"))).toBe(false);
		// o cartão só vira "concluído" quando a tela de login sumiu
		expect(second.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
		expect(second.requests).toHaveLength(0);
	});

	it("Terminei com a tela já logada: segue e manda reler a página", async () => {
		await addChatgpt();
		const { checkpoint } = await pausedWithOffer();
		const second = await run({ queue: [text("ok")], restored: checkpoint });
		expect(second.seen.some((m) => m.includes("[login-complete]"))).toBe(true);
		expect(second.execBrowserSnapshot).toHaveBeenCalled();
	});

	it("o site já pediu login nesta conversa (run anterior, 30 min): sem card novo, o modelo recebe a nota", async () => {
		const { error, events, seen, onLoginRequired } = await run({ queue: [step("browser_snapshot"), text("O site ainda pede login.")], recentLoginAsks: { asked: ["chatgpt.com"] } });
		expect(error).toBeUndefined();
		expect(events.filter((e) => e.type === "login" && e.status !== "done")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(seen.some((m) => m.includes("LOGIN STILL REQUIRED on chatgpt.com") && m.includes("last 30 minutes"))).toBe(true);
	});

	it("outro site da conversa não é bloqueado pelo aviso de um site já perguntado", async () => {
		const { error, events } = await run({ queue: [step("browser_snapshot")], recentLoginAsks: { asked: ["outro.example.com"] } });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(events.find((e) => e.type === "login" && e.status === "pending")).toMatchObject({ site: "chatgpt.com" });
	});

	it("login salvo continua entrando sozinho mesmo com aviso recente do site", async () => {
		await addChatgpt();
		const { error, events, execBrowserType } = await run({ queue: [step("browser_snapshot"), text("ok")], recentLoginAsks: { asked: ["chatgpt.com"] }, snapshotAfterTyping: homeSnapshot, pageAfter: { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?" } });
		expect(error).toBeUndefined();
		expect(execBrowserType).toHaveBeenCalled();
		expect(events.filter((e) => e.type === "login" && e.status !== "done")).toHaveLength(0);
	});

	it("o Cofre já falhou neste site na conversa (30 min): não digita a senha de novo e mostra o card humano", async () => {
		await addChatgpt();
		const { error, events, execBrowserType } = await run({ queue: [step("browser_snapshot")], recentLoginAsks: { vaultTried: ["chatgpt.com"] } });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(execBrowserType).not.toHaveBeenCalled();
		const card = events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ site: "chatgpt.com" });
		expect(card).toHaveProperty("vaultTried");
		expect(card).not.toHaveProperty("vault");
	});

	it("login do cofre que não resolveu sozinho não reabre cartão na conversa enquanto o anterior está pendente", async () => {
		await addChatgpt();
		const { events, onLoginRequired, seen } = await run({ queue: [step("browser_snapshot"), text("Preciso da sua aprovação.")], recentLoginAsks: { asked: ["chatgpt.com"] } });
		expect(events.filter((e) => e.type === "login" && e.status !== "done")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(seen.some((m) => m.includes("LOGIN STILL REQUIRED on chatgpt.com"))).toBe(true);
	});

	it("as pesquisas de card recente só rodam quando uma tela de login aparece", async () => {
		const spy = vi.fn();
		await run({ queue: [text("Bom dia!")], recentLoginAsksSpy: spy });
		expect(spy).not.toHaveBeenCalled();
		await run({ queue: [step("browser_snapshot")], recentLoginAsksSpy: spy });
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

// ----- caso real: Adolfinho / Dokploy (panel.kodea.com.br, item "Painel - Kodea") -----

const KODEA = "https://panel.kodea.com.br/login";
const KODEA_PASSWORD = "KodeaPass!99";
const kodeaHome = () => ({ url: "https://panel.kodea.com.br/", title: "Dokploy", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['[e1] heading "Projetos"'] });
const typedOf2 = (r: { execBrowserType: { mock: { calls: unknown[][] } } }) => r.execBrowserType.mock.calls.map((c) => (c[1] as { text: string }).text);

async function addKodea(userId = "user-a", name = "painel-kodea", label = "Painel - Kodea", siteUrl?: string) {
	// Sem siteUrl: o item só tem nome/rótulo, e nome NUNCA autoriza digitar (o dono vincula o host uma vez).
	await vault.create(userId, { kind: "login", name, label, username: "dono@kodea.com.br", payload: { password: KODEA_PASSWORD }, ...(siteUrl ? { siteUrl } : {}) });
}
const linkKodea = async () => {
	const item = (await vault.listMeta("user-a")).find((i) => i.name === "painel-kodea")!;
	await vault.update("user-a", item.id, { siteUrl: "https://panel.kodea.com.br" });
};

/** Run parado num cartão de login da rotina (checkpoint como o do caso real). */
async function pausedOnKodea() {
	const first = await run({ queue: [step("browser_snapshot")], userId: "user-sem-cofre", url: KODEA });
	return structuredClone(first.checkpoints.at(-1)!);
}

describe("login pendente não engole a fala do dono (caso real)", () => {
	it("'o cofre está como: Painel - Kodea' chega ao modelo; item sem site: 1 cartão de vínculo, nada digitado, sem frase fixa nem 'concluído' falso", async () => {
		await addKodea();
		const checkpoint = await pausedOnKodea();
		const second = await run({
			restored: checkpoint,
			url: KODEA,
			steer: [{ id: "in-1", content: "o cofre está como: Painel - Kodea", mode: "steer" }],
			snapshotOnResume: () => wallSnapshot(KODEA),
			// a 1ª chamada é a triagem da mensagem recebida durante o run (resposta vazia = padrão)
			queue: [text("{}"), step("login_fill", { login: "Painel - Kodea", submit: true }), text("Pedi a confirmação.")],
		});
		expect(second.requests.length).toBeGreaterThan(0);
		const seenAll = second.seen.join("\n");
		expect(seenAll).toContain("o cofre está como: Painel - Kodea");
		expect(seenAll).toContain("[auto-context");
		expect(seenAll).not.toContain("Ainda vejo a tela de login");
		const cards = second.events.filter((e) => e.type === "confirm");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ title: "Usar o login do Cofre Painel - Kodea em panel.kodea.com.br?" });
		expect(typedOf2(second)).toEqual([]);
		expect(second.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
		expect(JSON.stringify([second.seen, second.events, second.checkpoints])).not.toContain(KODEA_PASSWORD);
		expect(second.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
	});

	it("fala já consumida (id no checkpoint) não é engolida pela frase fixa: o modelo roda", async () => {
		const checkpoint = await pausedOnKodea();
		checkpoint.consumedInputIds = ["in-9"];
		const r = await run({ restored: checkpoint, url: KODEA, steer: [{ id: "in-9", content: "to te falando que o login está no cofre", mode: "steer" }], snapshotOnResume: () => wallSnapshot(KODEA), queue: [text("Vou olhar o cofre.")] });
		expect(r.requests.length).toBeGreaterThan(0);
		expect(r.result?.text ?? "").not.toContain("Ainda vejo a tela de login");
		expect(r.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
	});

	it("cada fala seguinte também chega ao modelo (nenhuma frase fixa repetida)", async () => {
		const checkpoint = await pausedOnKodea();
		for (const content of ["to te falando que o login está no cofre", "Pq vc n pediu a porra do cofre?"]) {
			const r = await run({ restored: checkpoint, url: KODEA, steer: [{ id: content, content, mode: "steer" }], queue: [text("Vou olhar o cofre.")] });
			expect(r.requests.length).toBeGreaterThan(0);
			expect(r.result?.text ?? "").not.toContain("Ainda vejo a tela de login");
			expect(r.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
		}
	});

	it("'pronto' com o login ainda na tela: a frase sai uma vez, o cartão segue pendente e a fala seguinte vai ao modelo", async () => {
		const checkpoint = await pausedOnKodea();
		const first = await run({ restored: checkpoint, url: KODEA, steer: [{ id: "in-1", content: "pronto" }], snapshotOnResume: () => wallSnapshot(KODEA), queue: [text("não deve chegar")] });
		expect(first.result?.text).toContain("Ainda vejo a tela de login de panel.kodea.com.br");
		expect(first.requests).toHaveLength(0);
		expect(first.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
		// o pendingLogin foi consumido: a próxima fala já não tem frase fixa
		expect(first.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
		const next = await run({ restored: first.checkpoints.at(-1)!, url: KODEA, steer: [{ id: "in-2", content: "o item do cofre é Painel - Kodea", mode: "steer" }], queue: [text("Certo.")] });
		expect(next.requests.length).toBeGreaterThan(0);
		expect(next.result?.text ?? "").not.toContain("Ainda vejo a tela de login");
	});

	it("'pronto' com o login que sumiu: cartão concluído e o modelo retoma", async () => {
		const checkpoint = await pausedOnKodea();
		const r = await run({ restored: checkpoint, url: KODEA, steer: [{ id: "in-1", content: "Pronto!" }], snapshotOnResume: kodeaHome, queue: [text("Continuando.")] });
		expect(r.seen.some((m) => m.includes("[login-complete]"))).toBe(true);
		expect(r.events.some((e) => e.type === "login" && e.status === "done")).toBe(true);
		expect(r.requests.length).toBeGreaterThan(0);
	});

	it("login pendente de uma ROTINA não é tratado como 'terminei' por uma fala do chat", async () => {
		const checkpoint = await pausedOnKodea();
		const r = await run({ restored: checkpoint, origin: "routine", url: KODEA, snapshotOnResume: () => wallSnapshot(KODEA), queue: [text("ok")] });
		expect(r.result?.text).not.toContain("Ainda vejo a tela de login");
		expect(r.events.some((e) => e.type === "login" && e.status === "done")).toBe(false);
		expect(r.requests.length).toBeGreaterThan(0);
		expect(r.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
	});
});

describe("rotina e chat entram pelo cofre sem cartão", () => {
	it("rotina: item COM o site salvo (panel.kodea.com.br) entra sozinho e não deixa login pendente", async () => {
		await addKodea("user-a", "painel-kodea", "Painel - Kodea", "https://panel.kodea.com.br");
		const r = await run({ origin: "routine", url: KODEA, queue: [step("browser_snapshot"), text("Consumo: ok")], snapshotAfterTyping: kodeaHome, pageAfter: { url: "https://panel.kodea.com.br/", title: "Dokploy", text: "Projetos" } });
		expect(r.error).toBeUndefined();
		expect(typedOf2(r)).toEqual(["dono@kodea.com.br", KODEA_PASSWORD]);
		expect(r.events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
		expect(r.onLoginRequired).not.toHaveBeenCalled();
		expect(r.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
		const done = r.events.find((e) => e.type === "login" && e.status === "done");
		expect(done).toMatchObject({ vault: { name: "painel-kodea", domain: "panel.kodea.com.br" } });
		// o registro discreto leva só o item: nada de usuário
		expect(JSON.stringify(done)).not.toContain("dono@kodea.com.br");
		expect(JSON.stringify([r.seen, r.events, r.checkpoints])).not.toContain(KODEA_PASSWORD);
	});

	it("chat: o mesmo item (com site) entra sozinho, sem cartão de aprovação", async () => {
		await addKodea("user-a", "painel-kodea", "Painel - Kodea", "https://panel.kodea.com.br");
		const r = await run({ url: KODEA, queue: [step("browser_snapshot"), text("Entrei.")], snapshotAfterTyping: kodeaHome, pageAfter: { url: "https://panel.kodea.com.br/", title: "Dokploy", text: "Projetos" } });
		expect(typedOf2(r)).toEqual(["dono@kodea.com.br", KODEA_PASSWORD]);
		expect(r.events.filter((e) => e.type === "confirm" || (e.type === "login" && e.status === "pending"))).toHaveLength(0);
	});

	it("replay completo: 1ª vez no chat pede o vínculo (1 cartão); depois entra sozinho no chat e a rotina seguinte entra sozinha", async () => {
		await addKodea();
		// 1ª vez (chat): o muro de login vira dica ao modelo, que chama login_fill e o dono vê UM cartão com o host
		const first = await run({ url: KODEA, queue: [step("browser_snapshot"), step("login_fill", { login: "painel-kodea" }), text("Confirma o site para eu entrar?")] });
		expect(first.events.filter((e) => e.type === "confirm")).toHaveLength(1);
		expect(first.events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
		expect(first.seen.some((m) => m.includes("may be for this site but has no site saved"))).toBe(true);
		expect(typedOf2(first)).toEqual([]);
		// "Sim" no cartão: grava o host exato no item do dono
		await linkKodea();
		const chat = await run({ url: KODEA, queue: [step("browser_snapshot"), text("Entrei.")], snapshotAfterTyping: kodeaHome, pageAfter: { url: "https://panel.kodea.com.br/", title: "Dokploy", text: "Projetos" } });
		expect(typedOf2(chat)).toEqual(["dono@kodea.com.br", KODEA_PASSWORD]);
		expect(chat.events.filter((e) => e.type === "confirm" || (e.type === "login" && e.status === "pending"))).toHaveLength(0);
		const routine = await run({ origin: "routine", url: KODEA, queue: [step("browser_snapshot"), text("Consumo: ok")], snapshotAfterTyping: kodeaHome, pageAfter: { url: "https://panel.kodea.com.br/", title: "Dokploy", text: "Projetos" } });
		expect(typedOf2(routine)).toEqual(["dono@kodea.com.br", KODEA_PASSWORD]);
		expect(routine.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
		expect(JSON.stringify([first, chat, routine].map((r) => [r.seen, r.events, r.checkpoints]))).not.toContain(KODEA_PASSWORD);
	});

	it("rotina com item SEM site: não digita, termina avisando o vínculo e não deixa pendência", async () => {
		await addKodea();
		const r = await run({ origin: "routine", url: KODEA, queue: [step("browser_snapshot"), text("Preciso que você vincule o site.")] });
		expect(typedOf2(r)).toEqual([]);
		expect(r.events.filter((e) => e.type === "login" || e.type === "confirm")).toHaveLength(0);
		expect(r.onLoginRequired).not.toHaveBeenCalled();
		expect(r.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
		expect(r.seen.some((m) => m.includes("a routine never types it") && m.includes("painel-kodea"))).toBe(true);
	});

	it("rotina sem item no cofre: termina com aviso claro, sem cartão, sem pausa e sem login pendente", async () => {
		const r = await run({ origin: "routine", url: KODEA, queue: [step("browser_snapshot"), text("Preciso entrar no painel.")] });
		expect(r.error).toBeUndefined();
		expect(r.events.filter((e) => e.type === "login")).toHaveLength(0);
		expect(r.onLoginRequired).not.toHaveBeenCalled();
		expect(r.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
		expect(r.seen.some((m) => m.includes("LOGIN NOT POSSIBLE on panel.kodea.com.br") && m.includes("unattended routine"))).toBe(true);
		expect(typedOf2(r)).toEqual([]);
	});

	it("dois itens servem à mesma página: o runtime não chuta, o modelo recebe os nomes e pergunta", async () => {
		await addKodea();
		await addKodea("user-a", "kodea-admin", "Kodea Admin");
		const r = await run({ url: KODEA, queue: [step("browser_snapshot"), text("Qual item uso?")] });
		expect(typedOf2(r)).toEqual([]);
		expect(r.events.filter((e) => e.type === "login")).toHaveLength(0);
		expect(r.seen.some((m) => m.includes("several logins") && m.includes("painel-kodea") && m.includes("kodea-admin"))).toBe(true);
	});

	it("item de OUTRO dono nunca é usado", async () => {
		await addKodea("user-b");
		const r = await run({ origin: "routine", url: KODEA, queue: [step("browser_snapshot"), text("sem login")] });
		expect(typedOf2(r)).toEqual([]);
		expect(JSON.stringify([r.seen, r.events])).not.toContain(KODEA_PASSWORD);
	});

	it("kodea.xyz, admin.kodea.com.br e atacante.vercel.app não recebem a senha de um item com site salvo", async () => {
		await addKodea("user-a", "painel-kodea", "Painel - Kodea", "https://panel.kodea.com.br");
		await vault.create("user-a", { kind: "login", name: "meuapp", label: "Meu app", siteUrl: "https://meuapp.vercel.app", username: "m@x.com", payload: { password: "MeuApp!99" } });
		for (const url of ["https://kodea.xyz/login", "https://admin.kodea.com.br/login", "https://atacante.vercel.app/login", "https://x.github.io/login"]) {
			const r = await run({ url, queue: [step("browser_snapshot"), text("x")] });
			expect(typedOf2(r), url).toEqual([]);
		}
	});

	it("página de outro domínio (phishing) não recebe a senha de um item só com nome", async () => {
		await addKodea();
		const r = await run({ url: "https://kodea.xyz/login", queue: [step("browser_snapshot"), text("x")] });
		expect(typedOf2(r)).toEqual([]);
		expect(r.events.filter((e) => e.type === "confirm")).toHaveLength(0);
	});
});
