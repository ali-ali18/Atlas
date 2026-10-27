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
	recentLoginSites?: string[];
	mcp?: McpRuntime;
}) {
	const events: Array<Record<string, unknown>> = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const seen: string[] = [];
	const requests: Array<{ tools: string[]; system: string }> = [];
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
		userId: "user-a",
		botId: "bot-1",
		origin: "chat",
		messages: [{ role: "user", content: "Faz login no chatgpt pra mim pfv" }],
		runId: "run-vl",
		conversationId: "conv-1",
		maxSteps: 10,
		vaultLoginSettleMs: 0,
		vaultEmailTimeoutMs: opts.emailTimeoutMs ?? 0,
		mcp: opts.mcp,
		restoredCheckpoint: opts.restored ?? null,
		onLoginRequired,
		...(opts.recentLoginSites ? { recentLoginSites: async () => opts.recentLoginSites! } : {}),
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(checkpoint);
		},
		onEvent: (event) => {
			events.push(event as unknown as Record<string, unknown>);
		},
		streamChat: async (request) => {
			for (const message of request.messages) if (typeof message.content === "string") seen.push(message.content);
			requests.push({
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

async function approveChatgpt() {
	const item = (await vault.listMeta("user-a"))[0]!;
	await vault.approveLogin("user-a", item.id, { botId: "bot-1", conversationId: "conv-1" });
}

async function pausedWithOffer(mcp?: McpRuntime) {
	const first = await run({ queue: [step("browser_snapshot")], mcp });
	const checkpoint = structuredClone(first.checkpoints.at(-1)!);
	return { first, checkpoint };
}

describe("Cofre automático no muro de login", () => {
	it("com login casando no cofre: o card oferece o Cofre e o checkpoint guarda a oferta (sem segredo)", async () => {
		await addChatgpt();
		const { error, events, checkpoints } = await run({ queue: [step("browser_snapshot")] });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		const card = events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ site: "chatgpt.com", vault: { name: "chatgpt", domain: "chatgpt.com", username: "alice@x.com" } });
		expect(JSON.stringify(events)).not.toContain(PASSWORD);
		const pending = checkpoints.at(-1)?.pendingLogin;
		expect(pending?.vault?.name).toBe("chatgpt");
		expect(pending?.useVault).toBeUndefined();
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
		// o clique foi a aprovação: ficou registrado para esta conversa
		const item = (await vault.listMeta("user-a"))[0]!;
		expect(await vault.isLoginApproved("user-a", item, "bot-1", "conv-1")).toBe(true);
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
		expect(String(human?.vaultTried)).toContain("mais um passo");
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

	it("com Gmail conectado: o cartão do cofre avisa que também busca o código", async () => {
		await addChatgpt();
		const { first } = await pausedWithOffer(gmailMcp([]).mcp);
		expect(first.events.find((e) => e.type === "login")).toMatchObject({ vault: { emailCode: "Gmail" } });
	});

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

describe("Cofre primeiro: login salvo e aprovado entra sozinho, antes do card", () => {
	it("aprovado + tela some depois de preencher: sem card, o modelo recebe a confirmação e a senha nunca aparece", async () => {
		await addChatgpt();
		await approveChatgpt();
		const { error, events, seen, execBrowserType, onLoginRequired } = await run({
			queue: [step("browser_snapshot"), text("Pronto, entrei.")],
			snapshotAfterTyping: homeSnapshot,
			pageAfter: { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?" },
		});
		expect(error).not.toBeInstanceOf(Error);
		expect(execBrowserType.mock.calls.map((c) => (c[1] as unknown as { text: string }).text)).toEqual(["alice@x.com", PASSWORD]);
		expect(events.filter((e) => e.type === "login")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(seen.some((m) => m.includes("[login-vault-filled]") && m.includes("browser_snapshot"))).toBe(true);
		expect(seen.some((m) => m.includes("LOGIN REQUIRED"))).toBe(false);
		expect(JSON.stringify([events, seen])).not.toContain(PASSWORD);
	});

	it("aprovado, mas a tela de login continua (senha errada/2FA): card humano explicando, sem a oferta do Cofre", async () => {
		await addChatgpt();
		await approveChatgpt();
		const { error, events, onLoginRequired, checkpoints } = await run({ queue: [step("browser_snapshot")] });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		const card = events.find((e) => e.type === "login" && e.status === "pending");
		expect(card).toMatchObject({ site: "chatgpt.com" });
		expect(String(card?.vaultTried)).toContain("mais um passo");
		expect(card?.vault).toBeUndefined();
		expect(onLoginRequired).toHaveBeenCalledTimes(1);
		expect(checkpoints.at(-1)?.pendingLogin?.vaultTried).toBeTruthy();
	});

	it("sem aprovação ainda: nada é digitado e o card é o de aprovação (oferta do Cofre)", async () => {
		await addChatgpt();
		const { events, execBrowserType } = await run({ queue: [step("browser_snapshot")], snapshotAfterTyping: homeSnapshot });
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(events.find((e) => e.type === "login" && e.status === "pending")).toMatchObject({ vault: { name: "chatgpt" } });
	});

	it("subdomínio do site salvo casa pelo domínio registrável (painel.chatgpt.com usa o login de chatgpt.com)", async () => {
		await addChatgpt();
		await approveChatgpt();
		const { events, execBrowserType } = await run({
			queue: [step("browser_snapshot"), text("ok")],
			url: "https://painel.chatgpt.com/entrar",
			snapshotAfterTyping: () => ({ ...homeSnapshot(), url: "https://painel.chatgpt.com/" }),
			pageAfter: { url: "https://painel.chatgpt.com/", title: "Painel", text: "Bem-vindo" },
		});
		expect(execBrowserType).toHaveBeenCalled();
		expect(events.filter((e) => e.type === "login")).toHaveLength(0);
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
		expect(second.events.some((e) => e.type === "login" && e.status === "done")).toBe(true);
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
		const { error, events, seen, onLoginRequired } = await run({ queue: [step("browser_snapshot"), text("O site ainda pede login.")], recentLoginSites: ["chatgpt.com"] });
		expect(error).toBeUndefined();
		expect(events.filter((e) => e.type === "login")).toHaveLength(0);
		expect(onLoginRequired).not.toHaveBeenCalled();
		expect(seen.some((m) => m.includes("LOGIN STILL REQUIRED on chatgpt.com") && m.includes("last 30 minutes"))).toBe(true);
	});

	it("outro site da conversa não é bloqueado pelo aviso de um site já perguntado", async () => {
		const { error, events } = await run({ queue: [step("browser_snapshot")], recentLoginSites: ["outro.example.com"] });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(events.find((e) => e.type === "login" && e.status === "pending")).toMatchObject({ site: "chatgpt.com" });
	});

	it("login salvo e aprovado continua entrando sozinho mesmo com aviso recente do site", async () => {
		await addChatgpt();
		await approveChatgpt();
		const { error, events, execBrowserType } = await run({ queue: [step("browser_snapshot"), text("ok")], recentLoginSites: ["chatgpt.com"], snapshotAfterTyping: homeSnapshot, pageAfter: { url: "https://chatgpt.com/", title: "ChatGPT", text: "Como posso ajudar hoje?" } });
		expect(error).toBeUndefined();
		expect(execBrowserType).toHaveBeenCalled();
		expect(events.filter((e) => e.type === "login")).toHaveLength(0);
	});
});
