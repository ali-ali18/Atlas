import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import { setVaultServiceForTests, VaultService } from "./secrets/vault-service.js";
import { executeLoginFill, executeRoutineWebhookInfo, executeSecretList, executeSecretRequest } from "./tools/vault-tools.js";
import { memoryVaultStore } from "./secrets/memory-store.js";

const routines = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	listUserRoutineWebhooks: vi.fn(async () => routines.list),
	hookPublicUrl: (key: string) => `https://app.example/v1/hooks/${key}`,
}));

const policy = { level: "balanced" as const, exceptions: [] };
const SECRET = "VALOR-REAL-SUPERSECRETO-123456";
const PASSWORD = "Sup3rSenha!XYZ";
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };
const asManager = (methods: Record<string, unknown>) => methods as unknown as SandboxManager;

let store: ReturnType<typeof memoryVaultStore>;
let vault: VaultService;

beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
	store = memoryVaultStore();
	vault = new VaultService(store);
	setVaultServiceForTests(vault);
	routines.list = [];
	await vault.create("user-a", { kind: "secret", name: "tok", description: "token de teste", payload: { value: SECRET } });
	await vault.create("user-a", { kind: "login", name: "github", label: "GitHub", siteUrl: "https://github.com/login", username: "alice@x.com", payload: { password: PASSWORD, totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" } });
});

async function run(calls: LlmToolCall[][], manager: SandboxManager, extra: Record<string, unknown> = {}) {
	let step = 0;
	const seen: string[] = [];
	const events: unknown[] = [];
	await runComputerUse({
		manager,
		getSessionId: async () => "s1",
		sandboxEnabled: true,
		apiKey: "test",
		model: "m",
		runId: "run-vault",
		userId: "user-a",
		botId: "bot-1",
		conversationId: "conv-1",
		origin: "chat",
		autonomy: policy,
		messages: [{ role: "user" as const, content: "Rode um script bash no terminal shell usando o segredo tok." }],
		onEvent: (event: unknown) => events.push(event),
		streamChat: async (params) => {
			seen.push(JSON.stringify(params.messages));
			const next = calls[step++];
			return next ? { model: "m", message: { role: "assistant", content: null, tool_calls: next } } : done;
		},
		...extra,
	} as Parameters<typeof runComputerUse>[0]);
	return { seen, events };
}

describe("cofre no loop do agente", () => {
	it("injeta o valor no shell da sandbox e o modelo nunca o recebe (resultado redigido)", async () => {
		const execShell = vi.fn(async (_s: string, params: { command: string }) => ({ background: false, exitCode: 0, stdout: `eco: ${params.command}`, stderr: "", durationMs: 5, timedOut: false, truncated: false }));
		const { seen, events } = await run([[call("t1", "sandbox_shell", { command: "echo {{secret:tok}}" })]], asManager({ execShell }));
		expect(execShell).toHaveBeenCalledTimes(1);
		expect(execShell.mock.calls[0]![1].command).toBe(`echo ${SECRET}`);
		const everything = seen.join("\n") + JSON.stringify(events);
		expect(everything).not.toContain(SECRET);
		expect(everything).toContain("{{secret:tok}}");
	});

	it("recusa marcador em web_search e navegador (nada sai) e não vaza", async () => {
		const execBrowserType = vi.fn();
		const { seen } = await run(
			[[call("t1", "web_search", { query: "{{secret:tok}}" }), call("t2", "browser_type", { text: "{{login:github.password}}" })]],
			asManager({ execBrowserType }),
		);
		expect(execBrowserType).not.toHaveBeenCalled();
		const everything = seen.join("\n");
		expect(everything).toContain("não podem ser usadas");
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain(PASSWORD);
	});

	it("segredo ausente devolve instrução de secret_request, sem inventar valor", async () => {
		const execShell = vi.fn();
		const { seen } = await run([[call("t1", "sandbox_shell", { command: "echo {{secret:nao-existe}}" })]], asManager({ execShell }));
		expect(execShell).not.toHaveBeenCalled();
		expect(seen.join("\n")).toContain("secret_request");
	});

	it("valor que aparece em saída de outra ferramenta (não referenciado agora) também é redigido", async () => {
		const execShell = vi.fn(async () => ({ background: false, exitCode: 0, stdout: `env: TOKEN=${SECRET} url=?k=${encodeURIComponent(SECRET)}`, stderr: "", durationMs: 5, timedOut: false, truncated: false }));
		const { seen } = await run([[call("t1", "sandbox_shell", { command: "env" })]], asManager({ execShell }));
		expect(seen.join("\n")).not.toContain(SECRET);
	});

	it("login_fill: preenche sem o valor passar pelo modelo, após aprovação, só no domínio certo", async () => {
		const typed: Array<{ selector?: string; text: string }> = [];
		const manager = asManager({
			execBrowserText: vi.fn(async () => ({ url: "https://accounts.github.com/login?x=1", title: "Sign in", text: `Entrar. valor digitado: ${PASSWORD}` })),
			execBrowserType: vi.fn(async (_s: string, params: { selector?: string; text: string }) => {
				typed.push(params);
				return { ok: true };
			}),
		});
		const { seen } = await run([[call("t1", "login_fill", { login: "github", fields: ["username", "password"] })], [call("t2", "browser_text", {})]], manager);
		expect(typed.map((t) => t.text)).toEqual(["alice@x.com", PASSWORD]);
		const everything = seen.join("\n");
		expect(everything).not.toContain(PASSWORD);
		expect(everything).toContain("sem passar os valores");
		// texto extraído da página com a senha: redigido
		expect(everything).toContain("{{login:github.password}}");
	});

	it("login_fill com submit devolve a URL e o título lidos depois de enviar e manda conferir a tela", async () => {
		const manager = asManager({
			execBrowserText: vi.fn(async () => ({ url: "https://github.com/login?x=1", title: "Sign in", text: "" })),
			execBrowserType: vi.fn(async () => ({ ok: true })),
		});
		const { seen } = await run([[call("t1", "login_fill", { login: "github", fields: ["username", "password"], submit: true })]], manager);
		const everything = seen.join("\n");
		expect(everything).toContain("Depois de enviar, a página está em");
		expect(everything).toContain("Sign in");
		expect(everything).toContain("https://github.com/login?x=1");
		expect(everything).toContain("browser_snapshot");
		expect(everything).not.toContain(PASSWORD);
	});

	it("login_fill recusa domínio diferente (phishing) e não digita nada", async () => {
		const execBrowserType = vi.fn(async () => ({ ok: true }));
		const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://github.com.evil.io/login", title: "", text: "" })), execBrowserType });
		const { seen } = await run([[call("t1", "login_fill", { login: "github" })]], manager);
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(seen.join("\n")).toContain("não é do site deste login");
	});

	it("login_fill sem aprovação prévia: usa o login do dono direto, sem cartão (chat)", async () => {
		const typed: string[] = [];
		const manager = asManager({
			execBrowserText: vi.fn(async () => ({ url: "https://github.com/login", title: "", text: "" })),
			execBrowserType: vi.fn(async (_s: string, p: { text: string }) => (typed.push(p.text), { ok: true })),
		});
		const { events, seen } = await run([[call("t1", "login_fill", { login: "github" })]], manager);
		expect(typed).toEqual(["alice@x.com", PASSWORD]);
		expect((events as Array<{ type?: string }>).some((e) => e.type === "confirm")).toBe(false);
		expect(seen.join("\n") + JSON.stringify(events)).not.toContain(PASSWORD);
	});

	it("login_fill em rotina (unattended) também entra sem cartão, no domínio certo", async () => {
		const typed: string[] = [];
		const manager = asManager({
			execBrowserText: vi.fn(async () => ({ url: "https://github.com/login", title: "", text: "" })),
			execBrowserType: vi.fn(async (_s: string, p: { text: string }) => (typed.push(p.text), { ok: true })),
		});
		const { events } = await run([[call("t1", "login_fill", { login: "github" })]], manager, { origin: "routine" });
		expect(typed).toEqual(["alice@x.com", PASSWORD]);
		expect((events as Array<{ type?: string }>).some((e) => e.type === "confirm")).toBe(false);
	});

	it("login_fill numa rotina em domínio diferente recusa e não digita", async () => {
		const execBrowserType = vi.fn(async () => ({ ok: true }));
		const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://github.com.evil.io/login", title: "", text: "" })), execBrowserType });
		const { seen } = await run([[call("t1", "login_fill", { login: "github" })]], manager, { origin: "routine" });
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(seen.join("\n")).toContain("não é do site deste login");
	});

	it("login de outro dono nunca é usado (login_fill só enxerga o cofre do dono do run)", async () => {
		await vault.create("user-b", { kind: "login", name: "banco-b", label: "Banco B", siteUrl: "https://banco.example", username: "b@x.com", payload: { password: "SenhaDoB!123" } });
		const execBrowserType = vi.fn(async () => ({ ok: true }));
		const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://banco.example/login", title: "", text: "" })), execBrowserType });
		const { seen } = await run([[call("t1", "login_fill", { login: "banco-b" })]], manager);
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(seen.join("\n")).toContain("não encontrado no cofre");
		expect(seen.join("\n")).not.toContain("SenhaDoB!123");
	});

	it("item SEM site: casar pelo nome nunca digita. Chat pergunta uma vez (cartão com o host); rotina recusa", async () => {
		await vault.create("user-a", { kind: "login", name: "painel-kodea", label: "Painel - Kodea", username: "dono@kodea.com.br", payload: { password: "KodeaPass!99" } });
		const execBrowserType = vi.fn(async () => ({ ok: true }));
		const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://panel.kodea.com.br/login", title: "", text: "" })), execBrowserType });
		const chat = await run([[call("t1", "login_fill", { login: "Painel - Kodea" })]], manager);
		const cards = (chat.events as Array<{ type?: string; title?: string; confirmLabel?: string }>).filter((e) => e.type === "confirm");
		expect(cards).toHaveLength(1);
		expect(cards[0]!.title).toBe("Usar o login do Cofre Painel - Kodea em panel.kodea.com.br?");
		expect(cards[0]!.confirmLabel).toBe("Sim, usar");
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(chat.seen.join("\n") + JSON.stringify(chat.events)).not.toContain("KodeaPass!99");
		const routine = await run([[call("t1", "login_fill", { login: "Painel - Kodea" })]], manager, { origin: "routine" });
		expect((routine.events as Array<{ type?: string }>).some((e) => e.type === "confirm")).toBe(false);
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(routine.seen.join("\n")).toContain("não tem site cadastrado");
	});

	it("domínios parecidos ou de plataforma NÃO recebem a senha (kodea.xyz, github.xyz, atacante.vercel.app, x.github.io)", async () => {
		await vault.create("user-a", { kind: "login", name: "kodea", label: "Kodea", siteUrl: "https://panel.kodea.com.br", username: "k@x.com", payload: { password: "KodeaPass!99" } });
		await vault.create("user-a", { kind: "login", name: "meuapp", label: "Meu app", siteUrl: "https://meuapp.vercel.app", username: "m@x.com", payload: { password: "MeuApp!99" } });
		await vault.create("user-a", { kind: "login", name: "meupages", label: "Pages", siteUrl: "https://dono.github.io", username: "p@x.com", payload: { password: "Pages!99" } });
		const cases: Array<[string, string]> = [
			["kodea", "https://kodea.xyz/login"],
			["kodea", "https://admin.kodea.com.br/login"],
			["kodea", "https://kodea.com.br/login"],
			["github", "https://github.xyz/login"],
			["meuapp", "https://atacante.vercel.app/login"],
			["meupages", "https://x.github.io/login"],
		];
		for (const [login, url] of cases) {
			const execBrowserType = vi.fn(async () => ({ ok: true }));
			const manager = asManager({ execBrowserText: vi.fn(async () => ({ url, title: "", text: "" })), execBrowserType });
			const r = await run([[call("t1", "login_fill", { login })]], manager);
			expect(execBrowserType, `${login} @ ${url}`).not.toHaveBeenCalled();
			expect(r.seen.join("\n")).toContain("Recusado");
		}
	});

	it("item com site panel.kodea.com.br digita só em panel.kodea.com.br (e filhos dele), em chat e rotina", async () => {
		await vault.create("user-a", { kind: "login", name: "kodea", label: "Kodea", siteUrl: "https://panel.kodea.com.br", username: "k@x.com", payload: { password: "KodeaPass!99" } });
		for (const origin of ["chat", "routine"]) {
			const typed: string[] = [];
			const manager = asManager({
				execBrowserText: vi.fn(async () => ({ url: "https://panel.kodea.com.br/login", title: "", text: "" })),
				execBrowserType: vi.fn(async (_s: string, p: { text: string }) => (typed.push(p.text), { ok: true })),
			});
			await run([[call("t1", "login_fill", { login: "kodea" })]], manager, { origin });
			expect(typed, origin).toEqual(["k@x.com", "KodeaPass!99"]);
		}
	});

	it("o 2FA (totp) nunca é digitado pelo bot, nem no chat nem em rotina", async () => {
		for (const origin of ["chat", "routine"]) {
			const execBrowserType = vi.fn(async () => ({ ok: true }));
			const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://github.com/login", title: "", text: "" })), execBrowserType });
			const r = await run([[call("t1", "login_fill", { login: "github", fields: ["totp"] })]], manager, { origin });
			expect(execBrowserType, origin).not.toHaveBeenCalled();
			expect(r.seen.join("\n")).toContain("2FA não é digitado pelo bot");
		}
	});

	it("password_selector (e totp_selector) é recusado: a senha só vai ao campo de senha achado pelo runtime", async () => {
		const execBrowserType = vi.fn(async () => ({ ok: true }));
		const manager = asManager({ execBrowserText: vi.fn(async () => ({ url: "https://github.com/login", title: "", text: "" })), execBrowserType });
		const r = await run([[call("t1", "login_fill", { login: "github", password_selector: "input[type=text]" })]], manager);
		expect(execBrowserType).not.toHaveBeenCalled();
		expect(r.seen.join("\n")).toContain("não aceito seletor para ele");
	});

	it("a digitação leva a trava do control server (senha = campo de senha; usuário = mesmo formulário) e a origem validada", async () => {
		const calls: Array<{ selector?: string; guard?: { kind: string; origin?: string } }> = [];
		const manager = asManager({
			execBrowserText: vi.fn(async () => ({ url: "https://github.com/login", title: "", text: "" })),
			execBrowserType: vi.fn(async (_s: string, p: { selector?: string; guard?: { kind: string; origin?: string } }) => (calls.push(p), { ok: true })),
		});
		await run([[call("t1", "login_fill", { login: "github", username_selector: "#login_field" })]], manager);
		expect(calls.map((c) => [c.selector, c.guard])).toEqual([
			["#login_field", { kind: "username", origin: "https://github.com" }],
			['input[type="password"]', { kind: "password", origin: "https://github.com" }],
		]);
	});

	it("troca de domínio entre o usuário e a senha: aborta sem digitar a senha", async () => {
		const typed: string[] = [];
		let reads = 0;
		const manager = asManager({
			// 1ª leitura: validação inicial; 2ª: antes do usuário; 3ª: antes da senha (já em outro site)
			execBrowserText: vi.fn(async () => ({ url: ++reads >= 3 ? "https://github.com.evil.io/login" : "https://github.com/login", title: "", text: "" })),
			execBrowserType: vi.fn(async (_s: string, p: { text: string }) => (typed.push(p.text), { ok: true })),
		});
		const r = await run([[call("t1", "login_fill", { login: "github" })]], manager);
		expect(typed).toEqual(["alice@x.com"]);
		expect(r.seen.join("\n")).toContain("A página mudou de site");
		expect(r.seen.join("\n")).not.toContain(PASSWORD);
	});
});

describe("ferramentas do cofre", () => {
	it("secret_list mostra nomes e domínio/usuário, nunca valores", async () => {
		const { summary } = await executeSecretList({ userId: "user-a" });
		expect(summary).toContain("{{secret:tok}}");
		expect(summary).toContain("github.com");
		expect(summary).toContain("alice@x.com");
		expect(summary).not.toContain(SECRET);
		expect(summary).not.toContain(PASSWORD);
		expect((await executeSecretList({ userId: "user-b" })).summary).toContain("vazio");
	});

	it("routine_webhook_info lista URL sem segredo, cabeçalho e marcador", async () => {
		const sealed = await vault.sealHookSecret("user-a", "hk1", "ROTSECRET-abcdefghij");
		routines.list = [
			{ routineId: "r1", botId: "b", name: "Resumo Diário", enabled: true, hookKey: "hk1", secretEnc: sealed },
			{ routineId: "r2", botId: "b", name: "Antiga", enabled: false, hookKey: "hk2", secretEnc: null },
		];
		const { summary } = await executeRoutineWebhookInfo({ userId: "user-a" });
		expect(summary).toContain("https://app.example/v1/hooks/hk1");
		expect(summary).toContain("X-Atlas-Hook-Secret: {{secret:rotina:resumo-diario}}");
		expect(summary).not.toContain("hk1?secret");
		expect(summary).not.toContain("ROTSECRET");
		expect(summary).toContain("Gerar novo segredo");
	});

	it("secret_request cria cartão (valor nunca no texto) e ignora o que já existe", async () => {
		const saved: unknown[] = [];
		const cards: unknown[] = [];
		const ctx = { userId: "user-a", conversationId: "conv-1", runId: "r", botId: "b", saveIntent: async (input: unknown) => void saved.push(input), persistCard: async (_c: string, card: unknown) => void cards.push(card) };
		const out = await executeSecretRequest({ names: ["stripe-key", "tok"], reason: "Para cobrar o cliente" }, ctx);
		expect(out.confirmEvent?.secretsRequest).toMatchObject({ environmentId: "vault", names: ["stripe-key"] });
		expect(out.confirmEvent?.title).toContain("stripe-key");
		expect(cards).toHaveLength(1);
		expect(JSON.stringify(saved)).toContain('"action":"request-secrets"');
		expect((await executeSecretRequest({ names: ["tok"], reason: "x" }, ctx)).summary).toContain("Já existem");
		await expect(executeSecretRequest({ names: ["nome inválido!"], reason: "x" }, ctx)).rejects.toThrow(/inválido/);
		await expect(executeSecretRequest({ names: ["a-b"], reason: "x" }, { ...ctx, unattended: true })).rejects.toThrow(/rotinas/);
	});

	it("login_fill: login de outro usuário não existe", async () => {
		await expect(executeLoginFill({ login: "github" }, { userId: "user-b", browser: { currentUrl: async () => "https://github.com", type: async () => undefined } })).rejects.toThrow(/não encontrado/);
	});
});
