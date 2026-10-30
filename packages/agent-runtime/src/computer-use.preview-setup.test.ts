import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { PreviewSetupState } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { createPreviewSetupContext } from "./tools/preview-setup/runtime.js";
import type { SetupDeps } from "./tools/preview-setup/machine.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "Configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Replay de "quero a prévia completa": LLM e provedores simulados, passando por todos os passos com as
 * confirmações, até "Prévia completa ligada". O estado vive fora do run (como no banco) e cada fala do usuário é um run.
 */
const TOKEN = "tok_SECRET_replay_987654";
const DOMAIN = "previas.exemplo.com";
const IP = "203.0.113.7";
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };
const call = (name: string, args: Record<string, unknown>, id: string): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } } satisfies LlmToolCall] },
});

function makeWorld() {
	const w = {
		state: null as PreviewSetupState | null,
		approved: new Set<string>(),
		cards: [] as Array<{ callKey: string }>,
		writes: [] as string[],
		tlsOk: false,
		probe: "route_missing" as "ok" | "route_missing" | "not_enabled",
		envApplied: false,
		record: null as string | null,
		/** Conversa até aqui: o roteador herda o assunto pela fala anterior (como "sim, continue"). */
		history: [] as Array<{ role: "user" | "assistant"; content: string }>,
	};
	const overrides: Partial<SetupDeps> = {
		atlasUrl: "https://atlas.meusite.com",
		loadState: async () => w.state,
		saveState: async (s) => { w.state = s; },
		deleteState: async () => { w.state = null; },
		getDnsToken: async () => TOKEN,
		providerFor: () => ({
			id: "cloudflare", automated: true,
			detectZone: async () => ({ id: "z1", name: "exemplo.com" }),
			findWildcard: async () => (w.record ? { id: "r1", content: w.record } : null),
			createWildcard: async (_z, _d, ip) => { w.writes.push("dns"); w.record = ip; return { id: "r1", content: ip }; },
			deleteRecord: async () => undefined,
		}),
		checks: {
			dns: async () => ({ ok: w.record !== null, found: w.record ? [IP] : [] }),
			tls: async () => (w.tlsOk ? { ok: true, issuer: "LE" } : { ok: false, reason: "unreachable" as const }),
			probe: async () => ({ kind: w.probe }),
		},
		findApproved: async (k) => w.approved.has(k),
		requestApproval: async ({ callKey }) => { w.cards.push({ callKey }); return { type: "confirm", confirmId: `confirm-${callKey.slice(0, 6)}`, title: "Criar?", callKey }; },
		envApplied: () => w.envApplied,
		sleep: async () => undefined,
	};
	return { w, overrides };
}

async function turn(input: { text: string; script: CompleteChatWithToolsResult[]; admin?: boolean; world: ReturnType<typeof makeWorld>; origin?: "chat" | "routine" }) {
	const requested: ChatTool[][] = [];
	const prompts: string[] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const events: string[] = [];
	const script = [...input.script];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "s1",
		apiKey: "test", model: "m", runId: "run-ps", userId: "admin-1", botId: "bot-a", conversationId: "conv-1",
		origin: input.origin ?? "chat",
		contextEconomy: true,
		previewSetup: createPreviewSetupContext({ userId: "admin-1", conversationId: "conv-1", runId: "run-ps", overrides: { ...input.world.overrides, isAdmin: async () => input.admin ?? true } }),
		messages: [...input.world.w.history, { role: "user" as const, content: input.text }],
		maxSteps: 8,
		onEvent: (event) => {
			events.push(event.type);
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			requested.push(JSON.parse(JSON.stringify(params.tools)) as ChatTool[]);
			prompts.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			return script.shift() ?? done;
		},
	});
	input.world.w.history.push({ role: "user", content: input.text }, { role: "assistant", content: "Sobre a prévia completa: feito, seguimos com o próximo passo." });
	return { first: requested[0]!.map((t) => t.function.name), system: prompts[0]!, results, events, prefix: JSON.stringify(requested[0]).length + prompts[0]!.length };
}

beforeEach(() => vi.clearAllMocks());

describe("economia: grupo preview_setup", () => {
	it("o pedido carrega a tool e o procedimento no passo 1 (só para o administrador); 'Bom dia' não", async () => {
		const world = makeWorld();
		const asked = await turn({ text: "quero a prévia completa", script: [done], world });
		expect(asked.first).toContain("preview_setup");
		expect(asked.system).toMatch(/Full live preview setup/);
		const greeting = await turn({ text: "Bom dia", script: [done], world: makeWorld() });
		expect(greeting.first).not.toContain("preview_setup");
		expect(greeting.system).not.toMatch(/Full live preview setup/);
		expect(greeting.prefix).toBeLessThan(asked.prefix);
	});
	it("não-administrador não recebe a tool nem com o pedido; rotina também não", async () => {
		const world = makeWorld();
		const other = await turn({ text: "quero a prévia completa", script: [done], world, admin: false });
		expect(other.first).not.toContain("preview_setup");
		const routine = await turn({ text: "quero a prévia completa", script: [done], world, origin: "routine" });
		expect(routine.first).not.toContain("preview_setup");
	});
});

describe("replay: 'quero a prévia completa' até 'Prévia completa ligada'", () => {
	it("passa por todos os passos, com aprovação antes de escrever e sem vazar o token", async () => {
		const world = makeWorld();
		const { w } = world;
		const all: string[] = [];
		const say = async (text: string, calls: Array<[Record<string, unknown>]>) => {
			const script = [...calls.map(([args], i) => call("preview_setup", args, `c${i}`)), done];
			// O roteador pega o assunto pela fala: o usuário continua falando da prévia completa.
			const out = await turn({ text: `${text} (prévia completa)`, script, world });
			all.push(...out.results.map((r) => r.summary));
			return out;
		};

		// 1. pedido: status → configure → run (para no cartão de aprovação)
		const first = await say("quero a prévia completa", [[{ action: "status" }], [{ action: "configure", domain: DOMAIN, dns_provider: "cloudflare", tls: "dns01-proxy", platform: "dokploy", server_ip: IP }], [{ action: "run" }]]);
		expect(first.events).toContain("confirm");
		expect(w.writes).toEqual([]);
		expect(w.cards).toHaveLength(1);

		// 2. usuário aprova o cartão → cria o registro e verifica
		w.approved.add(w.cards[0]!.callKey);
		await say("confirmado: Criar o endereço curinga das prévias?", [[{ action: "run" }]]);
		expect(w.writes).toEqual(["dns"]);
		expect(w.state?.steps.dns.status).toBe("done");

		// 3. certificado: instruções, depois verificação (primeiro falha, depois passa)
		await say("continua", [[{ action: "run" }], [{ action: "run" }]]);
		expect(w.state?.steps.tls.status).toBe("awaiting_user");
		w.tlsOk = true;
		await say("já fiz o certificado", [[{ action: "run" }]]);
		expect(w.state?.steps.tls.status).toBe("done");

		// 4. rota: instruções; o proxy passa a responder (a API ainda sem a variável)
		await say("segue", [[{ action: "run" }]]);
		w.probe = "not_enabled";
		await say("rota feita", [[{ action: "run" }]]);
		expect(w.state?.steps.route.status).toBe("done");

		// 5. variável e reinício: guiados, com o aval do usuário
		await say("segue", [[{ action: "run" }]]);
		await say("variável posta", [[{ action: "run", user_confirms: true }], [{ action: "run" }]]);
		await say("reiniciei", [[{ action: "run", user_confirms: true }]]);
		expect(w.state?.steps.env.status).toBe("done");
		expect(w.state?.steps.redeploy.status).toBe("done");

		// 6. servidor reiniciou (outra instância): retoma pelo status e faz o teste final
		w.probe = "ok";
		w.envApplied = true;
		const final = await say("voltei", [[{ action: "status" }], [{ action: "run" }]]);
		expect(final.results.at(-1)!.summary).toContain("Prévia completa ligada");
		expect(w.state && Object.values(w.state.steps).every((s) => s.status === "done")).toBe(true);
		expect(all.every((summary) => !summary.includes(TOKEN))).toBe(true);
		expect(JSON.stringify(w.state)).not.toContain(TOKEN);
	});

	it("sem o aval do cartão nada é escrito, mesmo se o modelo insistir", async () => {
		const world = makeWorld();
		await turn({ text: "x", script: [call("preview_setup", { action: "configure", domain: DOMAIN, dns_provider: "cloudflare", tls: "dns01-proxy", platform: "generic", server_ip: IP }, "a"), call("preview_setup", { action: "run" }, "b"), call("preview_setup", { action: "run" }, "c"), done], world });
		expect(world.w.writes).toEqual([]);
		expect(world.w.record).toBeNull();
	});
});
