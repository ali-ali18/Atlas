import { describe, expect, it } from "vitest";
import type { AutonomyLevel } from "@workspace/shared";
import { decide, explainDecision, humanPresentFor, PREPARE_FOR_OWNER_TOOL, type PolicyContext, type PolicyDecision, type PolicyTool } from "./decide.js";
import { mcpPolicyTool, nativePolicyTool } from "./tool.js";

const ctxFor = (origin: string, autonomy: AutonomyLevel, extra: Partial<PolicyContext> = {}): PolicyContext => ({
	origin,
	humanPresent: humanPresentFor(origin, extra.parentOrigin),
	autonomy,
	...extra,
});

type Effect = PolicyTool["effect"];
const tool = (effect: Effect, name = `t_${effect}`): PolicyTool => ({ name, effect });
const EFFECTS: Effect[] = ["read", "write_internal", "write_external", "send", "money", "public_link", "credential"];
const LEVELS: AutonomyLevel[] = ["autonomous", "balanced", "always_ask"];

// Origem sem humano: a mesma coluna para qualquer autonomia (a autonomia só decide quando há quem aprovar).
const NO_HUMAN: Record<Effect, Record<AutonomyLevel, PolicyDecision>> = {
	read: { autonomous: "allow", balanced: "allow", always_ask: "allow" },
	write_internal: { autonomous: "allow", balanced: "allow", always_ask: "deny" },
	write_external: { autonomous: "hide", balanced: "hide", always_ask: "hide" },
	send: { autonomous: "hide", balanced: "hide", always_ask: "hide" },
	money: { autonomous: "hide", balanced: "hide", always_ask: "hide" },
	public_link: { autonomous: "hide", balanced: "hide", always_ask: "hide" },
	credential: { autonomous: "hide", balanced: "hide", always_ask: "hide" },
};
const CHAT: Record<Effect, Record<AutonomyLevel, PolicyDecision>> = {
	read: { autonomous: "allow", balanced: "allow", always_ask: "allow" },
	write_internal: { autonomous: "allow", balanced: "allow", always_ask: "ask" },
	write_external: { autonomous: "allow", balanced: "ask", always_ask: "ask" },
	send: { autonomous: "ask", balanced: "ask", always_ask: "ask" },
	money: { autonomous: "ask", balanced: "ask", always_ask: "ask" },
	public_link: { autonomous: "ask", balanced: "ask", always_ask: "ask" },
	credential: { autonomous: "ask", balanced: "ask", always_ask: "ask" },
};

describe("matriz origem x autonomia x efeito", () => {
	for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) {
		for (const effect of EFFECTS) {
			for (const level of LEVELS) {
				it(`${origin} / ${level} / ${effect} -> ${NO_HUMAN[effect][level]}`, () => {
					expect(decide(tool(effect), ctxFor(origin, level))).toBe(NO_HUMAN[effect][level]);
				});
			}
		}
	}
	for (const effect of EFFECTS) {
		for (const level of LEVELS) {
			it(`chat / ${level} / ${effect} -> ${CHAT[effect][level]}`, () => {
				expect(decide(tool(effect), ctxFor("chat", level))).toBe(CHAT[effect][level]);
			});
		}
	}
});

describe("casos obrigatorios", () => {
	it("rotina nunca escreve em conector, em nenhuma autonomia", () => {
		for (const level of LEVELS) {
			expect(decide(mcpPolicyTool("mcp__erp__criar_proposta", { connectionId: "c1", readOnly: false }), ctxFor("routine", level, { confirmWrites: false }))).toBe("hide");
			expect(decide(mcpPolicyTool("mcp__erp__buscar_cliente", { connectionId: "c1", readOnly: true }), ctxFor("routine", level))).toBe("allow");
		}
	});

	it("e-mail recebido nao envia sem aprovacao, nem com a caixa em resposta automatica", () => {
		for (const name of ["email_reply", "email_send"]) {
			expect(decide(tool("send", name), ctxFor("email", "autonomous"))).toBe("hide");
			expect(decide(tool("send", name), ctxFor("email", "autonomous", { emailAutoReply: true }))).toBe("hide");
		}
		expect(decide(tool("read", "email_read"), ctxFor("email", "balanced"))).toBe("allow");
	});

	it("chat com humano: e-mail pede cartao, salvo caixa com resposta automatica", () => {
		expect(decide(tool("send", "email_reply"), ctxFor("chat", "autonomous"))).toBe("ask");
		expect(decide(tool("send", "email_reply"), ctxFor("chat", "autonomous", { emailAutoReply: false }))).toBe("ask");
		expect(decide(tool("send", "email_reply"), ctxFor("chat", "balanced", { emailAutoReply: true }))).toBe("allow");
		// a resposta automatica vale so para e-mail: notificar/enviar outra coisa continua pedindo
		expect(decide(tool("send", "notify_user"), ctxFor("chat", "balanced", { emailAutoReply: true }))).toBe("ask");
	});

	it("outro bot pedindo nao dispara escrita (so leitura)", () => {
		for (const effect of EFFECTS.filter((e) => e !== "read" && e !== "write_internal")) {
			expect(decide(tool(effect), ctxFor("bot", "autonomous"))).toBe("hide");
		}
		expect(decide(tool("read"), ctxFor("bot", "autonomous"))).toBe("allow");
		expect(decide(nativePolicyTool("send_to_bot")!, ctxFor("bot", "autonomous"))).toBe("hide");
	});

	it("subagente herda a origem do pai", () => {
		// filho de rotina: sem humano, igual a rotina
		expect(decide(tool("write_external"), ctxFor("subagent", "autonomous", { parentOrigin: "routine" }))).toBe("hide");
		expect(decide(tool("send"), ctxFor("subagent", "autonomous", { parentOrigin: "email" }))).toBe("hide");
		// filho de chat: o humano existe, mas o filho nao mostra cartao: o que pediria aprovacao e negado
		expect(decide(tool("write_external"), ctxFor("subagent", "autonomous", { parentOrigin: "chat" }))).toBe("allow");
		expect(decide(tool("write_external"), ctxFor("subagent", "balanced", { parentOrigin: "chat" }))).toBe("deny");
		expect(decide(tool("send"), ctxFor("subagent", "autonomous", { parentOrigin: "chat" }))).toBe("deny");
		// pai desconhecido: tratado como sem humano
		expect(decide(tool("write_external"), ctxFor("subagent", "autonomous"))).toBe("hide");
		// humanPresent verdadeiro vindo de fora nao vence a origem herdada
		expect(decide(tool("write_external"), { origin: "subagent", parentOrigin: "routine", humanPresent: true, autonomy: "autonomous" })).toBe("hide");
	});

	it("needsHuman: sem humano some, com humano segue as regras", () => {
		const setAutonomy = nativePolicyTool("set_autonomy")!;
		expect(setAutonomy.needsHuman).toBe(true);
		for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) expect(decide(setAutonomy, ctxFor(origin, "autonomous"))).toBe("hide");
		expect(decide(setAutonomy, ctxFor("subagent", "autonomous", { parentOrigin: "routine" }))).toBe("hide");
		expect(decide(setAutonomy, ctxFor("chat", "autonomous"))).toBe("allow");
	});

	it("api_call: aparece no catalogo da rotina; GET roda, POST e negado com motivo na execucao", () => {
		const routine = ctxFor("routine", "balanced");
		// catalogo (sem args): efeito mais permissivo, a tool aparece
		expect(decide(nativePolicyTool("api_call")!, routine)).toBe("allow");
		const get = nativePolicyTool("api_call", { method: "GET" })!;
		expect(get.effect).toBe("read");
		expect(decide(get, { ...routine, stage: "execute" })).toBe("allow");
		expect(decide(nativePolicyTool("api_call", {})!, { ...routine, stage: "execute" })).toBe("allow");
		const post = explainDecision(nativePolicyTool("api_call", { method: "POST" })!, { ...routine, stage: "execute" });
		expect(post.decision).toBe("deny");
		expect(post.reason).toMatch(/only GET\/HEAD/);
		// o mesmo POST, avaliado como montagem de catalogo, esconderia (nao e usado assim)
		expect(decide(nativePolicyTool("api_call", { method: "POST" })!, routine)).toBe("hide");
	});

	it("sandbox_download: aparece em rotina; com cookies e negado com dica acionavel, sem a sessao roda", () => {
		const routine = ctxFor("routine", "autonomous");
		expect(decide(nativePolicyTool("sandbox_download")!, routine)).toBe("allow");
		const withCookies = nativePolicyTool("sandbox_download", { url: "https://x.test/a" })!;
		expect(withCookies.effect).toBe("credential");
		const denied = explainDecision(withCookies, { ...routine, stage: "execute" });
		expect(denied.decision).toBe("deny");
		expect(denied.reason).toMatch(/set use_browser_session false/);
		const plain = nativePolicyTool("sandbox_download", { url: "https://x.test/a", use_browser_session: false })!;
		expect(decide(plain, { ...routine, stage: "execute" })).toBe("allow");
		expect(decide(withCookies, ctxFor("chat", "autonomous"))).toBe("ask");
	});

	it("rotina pode notificar o dono (notify_user e write_internal, nao envio a terceiro)", () => {
		const notify = nativePolicyTool("notify_user")!;
		expect(notify.effect).toBe("write_internal");
		for (const origin of ["routine", "proactive"]) expect(decide(notify, ctxFor(origin, "balanced"))).toBe("allow");
	});

	it("tools que so existem com humano hoje somem sem humano e seguem no chat", () => {
		for (const name of ["propose_questionnaire", "sandbox_release", "propose_skill", "propose_skill_change", "propose_skill_delete", "delete_skill", "delegate", "delegate_task", "propose_bot"]) {
			const t = nativePolicyTool(name)!;
			expect(t.needsHuman, name).toBe(true);
			for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) expect(decide(t, ctxFor(origin, "autonomous")), `${name}/${origin}`).toBe("hide");
			expect(decide(t, ctxFor("chat", "balanced")), name).toBe("allow");
		}
	});

	it("prepare_for_owner e a unica escrita sem humano (ponto de extensao: a tool ainda nao existe)", () => {
		for (const level of LEVELS) expect(decide({ name: PREPARE_FOR_OWNER_TOOL, effect: "write_internal" }, ctxFor("routine", level))).toBe("allow");
		// PENDENTE (PR da tool prepare_for_owner): provar que o rascunho de e-mail/escrita em conector/publicacao
		// aparece como cartao aprovavel no chat do dono e que so a aprovacao dele executa a escrita real.
	});
});

describe("regras com humano", () => {
	it("conector so-leitura esconde a escrita, em qualquer origem", () => {
		const write = mcpPolicyTool("mcp__erp__criar", { connectionId: "c1", readOnly: false });
		expect(decide(write, ctxFor("chat", "autonomous", { connectorReadOnly: (id) => id === "c1" }))).toBe("hide");
		expect(decide(write, ctxFor("chat", "autonomous", { connectorReadOnly: (id) => id === "outro" }))).toBe("allow");
		const read = mcpPolicyTool("mcp__erp__ler", { connectionId: "c1", readOnly: true });
		expect(decide(read, ctxFor("chat", "autonomous", { connectorReadOnly: () => true }))).toBe("allow");
	});

	it("confirmWrites pede cartao mesmo no autonomo", () => {
		const write = mcpPolicyTool("mcp__erp__criar", { connectionId: "c1", readOnly: false });
		expect(decide(write, ctxFor("chat", "autonomous", { confirmWrites: true }))).toBe("ask");
		expect(decide(write, ctxFor("chat", "autonomous"))).toBe("allow");
	});

	it("plano pendente pede cartao nas escritas, nao nas leituras", () => {
		expect(decide(tool("write_internal"), ctxFor("chat", "autonomous", { planPending: true }))).toBe("ask");
		expect(decide(tool("write_external"), ctxFor("chat", "autonomous", { planPending: true }))).toBe("ask");
		expect(decide(tool("read"), ctxFor("chat", "autonomous", { planPending: true }))).toBe("allow");
	});

	it("regras do usuario: confirm_always pede, always_ask pede, never_ask libera, blocked esconde", () => {
		const write = mcpPolicyTool("mcp__erp__criar", { connectionId: "c1", readOnly: false });
		expect(decide(write, ctxFor("chat", "autonomous", { userRules: { confirmAlways: true } }))).toBe("ask");
		expect(decide(write, ctxFor("chat", "autonomous", { userRules: { mode: "always_ask" } }))).toBe("ask");
		expect(decide(write, ctxFor("chat", "always_ask", { userRules: { mode: "never_ask" } }))).toBe("allow");
		expect(decide(write, ctxFor("chat", "autonomous", { userRules: { mode: "blocked" } }))).toBe("hide");
		// never_ask nao libera link publico nem segredo
		expect(decide(tool("public_link"), ctxFor("chat", "autonomous", { userRules: { mode: "never_ask" } }))).toBe("ask");
		expect(decide(tool("credential"), ctxFor("chat", "autonomous", { userRules: { mode: "never_ask" } }))).toBe("ask");
	});

	it("a mais restritiva vence: ask de varias fontes continua ask; sem humano o ask vira deny", () => {
		expect(decide(tool("write_internal"), ctxFor("routine", "always_ask"))).toBe("deny");
		expect(decide(tool("write_internal"), ctxFor("routine", "autonomous", { planPending: true }))).toBe("deny");
		expect(decide(tool("write_internal"), ctxFor("webhook", "autonomous", { userRules: { confirmAlways: true } }))).toBe("deny");
	});

	it("traz um motivo curto em ingles", () => {
		expect(explainDecision(tool("send"), ctxFor("routine", "autonomous")).reason).toMatch(/no human present/);
		expect(explainDecision(tool("read"), ctxFor("chat", "balanced"))).toEqual({ decision: "allow", reason: "read" });
	});
});

describe("efeito vem do metadado do registro", () => {
	it("tools sem metadado (desconhecidas) nao viram PolicyTool", () => {
		expect(nativePolicyTool("ferramenta_que_nao_existe")).toBeUndefined();
	});
	it("conector MCP: leitura = read, resto = write_external", () => {
		expect(mcpPolicyTool("mcp__a__b", { connectionId: "c", readOnly: true }).effect).toBe("read");
		expect(mcpPolicyTool("mcp__a__b", { connectionId: "c", readOnly: false }).effect).toBe("write_external");
	});
});
