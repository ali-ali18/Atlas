import { paymentRig } from "../testing/payment-fakes.js";
import { createDeliverablesCapability } from "../capabilities-builtin/deliverables/index.js";
import { FakeEmail } from "../presets/fake-email.js";
import { FakeAgenda, FakeCalendar, FakeDeliverables, FakeHelpers, FakeFileStore, FakeImages, FakeMemory, FakeNotebook, FakeSearch, FakeSettings, FakeShopping, FakeTaskListStore } from "../presets/fakes.js";
import { setupPreset } from "../presets/presets.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFECT_CLASSES as SHARED_EFFECTS, HANDOFF_ACTIONS, SURFACES, decide, type DecideInput } from "@workspace/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { USE_CAPABILITY_TOOL, createAgendaRunCapability, createBriefCapability, createCapabilityRegistry, createLoadedSet, defineCapability } from "../capabilities/index.js";
import { EFFECT_CLASSES, type Effect, RunProvenance, createExecutor, grantApproval, isEffect, type ApprovalGrant, type PolicyContext } from "../contract/index.js";
import { TOOL_SEARCH_TOOL } from "../connectors/capability.js";
import { ASK_OWNER_TOOL, createAskOwnerTool } from "../kernel/ask-owner.js";
import { NOTE_READ_TOOL, createNoteReadTool, DEFAULT_PAGE_CHARS } from "../kernel/work-notes.js";
import { fakePorts, sha256 } from "../testing/fake-ports.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import type { Vault } from "../ports/vault.js";

// Invariantes do contrato de comportamento (06, coluna "Teste invariante"; 05-fases, guardas #4).
// Usa o executor e o kernel REAIS com portas falsas. Quatro famílias:
//  A. toda tool registrada declara efeito (e uma tool nova no código sem entrar aqui falha);
//  B. nenhum efeito de alto risco roda sem grant válido quando `decide` pede aprovação;
//  C. handoff nunca executa, em nenhuma superfície, regra ou grant;
//  D. segredo do cofre nunca aparece em evento, journal, resultado de tool ou mensagem ao modelo.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTONOMIES = ["always_ask", "balanced", "autonomous"] as const;
type AutonomyName = (typeof AUTONOMIES)[number];
const HIGH_RISK: readonly Effect[] = ["send", "money", "public_link", "destructive", "write_external"];
const hash = sha256;

// ---------------------------------------------------------------- A. efeito declarado

/** Todas as portas do preset `full`: assim nenhuma capacidade fica de fora do registro de teste. */
function fullDeps() {
	return { search: new FakeSearch(), files: new FakeFileStore(), memory: new FakeMemory(), notebook: new FakeNotebook(), settings: new FakeSettings(undefined, { codeMode: {} }), taskLists: new FakeTaskListStore(), helpers: new FakeHelpers(), agenda: new FakeAgenda(), shopping: new FakeShopping().ports, email: new FakeEmail().ports, calendar: new FakeCalendar().ports, checkout: { cards: [paymentRig().info], fill: paymentRig().fill }, code: {}, browser: true, images: new FakeImages().port };
}

/** Todas as tools que existem hoje em `packages/agent` (núcleo do kernel + as de capacidade). */
function allRegisteredTools(): Tool[] {
	const kernelCapability = defineCapability({ id: "kernel", title: "Kernel", summary: "kernel tools", core: true, tools: [createNoteReadTool(DEFAULT_PAGE_CHARS), createAskOwnerTool()] });
	const registry = createCapabilityRegistry([kernelCapability]);
	const loaded = createLoadedSet(registry);
	const preset = setupPreset("full", fullDeps());
	// `deliverables` (F2.3) substitui a lite quando as portas existem; as duas são conferidas.
	const rich = createDeliverablesCapability(new FakeDeliverables().ports());
	// `agenda-run` (F4.2) só existe nos runs de agenda: não faz parte do preset, mas a tool tem de declarar efeito igual.
	const agendaRun = createAgendaRunCapability(new FakeAgenda());
	// `brief` (F7.2) também só existe nos runs do plano do dia.
	const brief = createBriefCapability({ agenda: new FakeAgenda() });
	return [...kernelCapability.tools, loaded.useCapabilityTool, ...preset.registry.capabilities.flatMap((c) => c.tools), ...rich.tools, ...agendaRun.tools, ...brief.tools];
}

function listTs(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return ["node_modules", "dist", "testing", "guards"].includes(name) ? [] : listTs(full);
		// `testing*` e `fixtures` são ferramentas de teste, não tools do motor.
		return full.endsWith(".ts") && !/\.(test|d)\.ts$|(^|\/)(testing|fixtures)\.ts$/.test(full) ? [full] : [];
	});
}

/** Constantes de nome usadas no lugar do literal (o AST não resolve imports). */
const NAME_CONSTANTS: Record<string, string> = { ASK_OWNER_TOOL, NOTE_READ_TOOL, USE_CAPABILITY_TOOL, TOOL_SEARCH_TOOL };

/**
 * Tools da capacidade `connectors` (F2.5): montadas por run com o dono, então não entram em `allRegisteredTools()`.
 * Os nomes `mcp_<slug>_read|write` são dinâmicos (um par por conexão). Efeito, privacidade e escopo delas são
 * conferidos em `connectors/connectors.test.ts` e `guards/private-data.test.ts`.
 */
const CONNECTOR_TOOL_DECLARATIONS: readonly string[] = [TOOL_SEARCH_TOOL, "<dynamic:names.read>", "<dynamic:names.write>"];

/** Nomes de tool declarados por `defineTool({ name: "..." })` no código de produção do pacote. */
export function declaredToolNames(code: string): string[] {
	const source = ts.createSourceFile("x.ts", code, ts.ScriptTarget.ES2022, true);
	const names: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineTool") {
			const arg = node.arguments[0];
			if (arg && ts.isObjectLiteralExpression(arg)) {
				for (const prop of arg.properties) {
					if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "name") {
						names.push(ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : (NAME_CONSTANTS[prop.initializer.getText(source)] ?? `<dynamic:${prop.initializer.getText(source)}>`));
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return names;
}

describe("A. toda tool registrada declara efeito", () => {
	const tools = allRegisteredTools();

	it("o registro de teste cobre o kernel de verdade", () => {
		expect(tools.map((t) => t.name).sort()).toEqual([ASK_OWNER_TOOL, NOTE_READ_TOOL, USE_CAPABILITY_TOOL, "create_file", "create_file", "create_page", "chart", "inspect_file", "web_extract", "web_search", "memory_list", "memory_add", "memory_update", "memory_remove", "update_task_list", "settings_get", "settings_update", "set_role_model", "settings_set_code_mode", "update_bot_profile", "research", "remind_me", "watch", "on_event", "brief_set", "agenda_list", "agenda_change", "agenda_result", "note_search", "note_get", "note_add", "note_update", "note_pin", "note_remove", "product_search", "record_purchase", "purchase_list", "purchase_update", "purchase_delete", "checkout", "email_list", "email_read", "email_triage", "email_draft", "email_send", "calendar_list", "calendar_get", "calendar_create", "calendar_update", "calendar_delete", "brief_sources", "day_plan", "code_session", "code_list", "code_read", "code_shell", "code_git_status", "code_diff", "code_edit", "code_write", "code_test", "browser_open", "browser_map", "browser_read", "browser_find", "browser_load_more", "browser_wait", "browser_tabs", "browser_screenshot", "browser_export", "browser_act", "browser_digest", "generate_image"].sort());
	});

	it("o vocabulário de efeitos do motor é o mesmo de shared", () => {
		expect([...EFFECT_CLASSES]).toEqual([...SHARED_EFFECTS]);
	});

	it.each(allRegisteredTools().map((t) => [t.name, t] as const))("%s: efeito válido, para qualquer argumento", (_name, tool) => {
		expect(isEffect(tool.effect)).toBe(true);
		for (const args of [{}, { id: "x" }, null, "texto", 42]) expect(isEffect(tool.effectFor(args))).toBe(true);
	});

	it("tool que lê dado privado do dono declara privateData, e só leitura leva a flag (auditoria F1, N2)", () => {
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const name of ["memory_list", "note_search", "note_get"]) expect(byName.get(name)?.privateData, name).toBe(true);
		const flagged = tools.filter((t) => t.privateData);
		expect(flagged.length).toBeGreaterThan(0);
		expect(flagged.every((t) => t.effect === "read")).toBe(true);
	});

	it("tool sem efeito (ou com efeito inventado) nem chega a existir", () => {
		const base = { name: "x_tool", description: "d", inputSchema: z.object({}), execute: () => ({ ok: true as const, summary: "s" }) };
		expect(() => defineTool({ ...base } as never)).toThrow(/effect/);
		expect(() => defineTool({ ...base, effect: "magic" } as never)).toThrow(/effect/);
	});

	it("toda tool definida no código de produção está no registro de teste (tool nova obriga a atualizar este arquivo)", () => {
		const registered = new Set([...allRegisteredTools().map((t) => t.name), ...CONNECTOR_TOOL_DECLARATIONS]);
		const declared = listTs(SRC).flatMap((file) => declaredToolNames(readFileSync(file, "utf8")));
		expect(declared.length).toBeGreaterThan(0);
		const missing = declared.filter((name) => !registered.has(name));
		expect(missing, `Tool(s) ${missing.join(", ")} existem no código mas não estão em allRegisteredTools() (guards/contract-invariants.test.ts). Registre-as para que o contrato de efeito seja conferido.`).toEqual([]);
	});

	// Resultado esperado por efeito (literal, escrito a partir do contrato e não derivado do código): [1ª chamada, chamada com grant].
	// A tool de prova NÃO devolve recibo, então todo efeito que sai de `read` termina em `contract_error` (efeito sem recibo nunca vira sucesso).
	const EXPECTED_BY_EFFECT: Record<Effect, readonly [string, string]> = {
		read: ["ok", "ok"],
		draft: ["contract_error", "contract_error"],
		write_internal: ["contract_error", "contract_error"],
		write_external: ["contract_error", "contract_error"],
		send: ["pending_approval", "contract_error"],
		money: ["pending_approval", "contract_error"],
		public_link: ["pending_approval", "contract_error"],
		credential: ["pending_approval", "contract_error"],
		destructive: ["pending_approval", "contract_error"],
	};

	it("o executor trata cada tool conforme o efeito: leitura sem journal, efeito com journal e sem sucesso sem recibo (auditoria F1, T5)", async () => {
		expect(Object.keys(EXPECTED_BY_EFFECT).sort()).toEqual([...EFFECT_CLASSES].sort());
		for (const effect of EFFECT_CLASSES) {
			const tool = defineTool({ name: "probe", description: "p", inputSchema: z.object({}), effect, execute: () => ({ ok: true, summary: "ok" }) });
			const fake = fakePorts();
			const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] };
			const executor = createExecutor({ runId: "r", ownerId: "o", ports: fake.ports, hash, policy });
			const first = await executor.executeCall({ callId: "c1", step: 0, tool, args: {} });
			const final = first.status === "pending_approval" ? await executor.executeCall({ callId: "c1", step: 0, tool, args: {}, grant: grantApproval(first.request, fake.clock.now()) }) : first;
			expect([first.status, final.status], effect).toEqual(EXPECTED_BY_EFFECT[effect]);
			if (effect === "read") expect(fake.journal.entries, effect).toHaveLength(0);
			else expect(fake.journal.entries.length, effect).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------- B. sem grant, sem efeito

type Counter = { runs: number };
function probeTool(effect: Effect, counter: Counter, handoff?: (typeof HANDOFF_ACTIONS)[number]): Tool {
	return defineTool({
		name: `probe_${effect}`,
		description: "probe",
		inputSchema: z.object({ to: z.string().optional() }),
		effect,
		riskFacts: () => ({ amount: 10, currency: "BRL", merchant: "loja" }),
		...(handoff && { handoffKind: () => handoff }),
		execute: () => (counter.runs++, { ok: true, summary: "done", receipt: { what: "feito" } }),
	});
}

function executorFor(policy: PolicyContext, tainted: boolean) {
	const fake = fakePorts();
	const provenance = new RunProvenance();
	if (tainted) provenance.record("conteúdo de uma página externa com bastante texto", "web");
	const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: fake.ports, hash, policy, provenance });
	return { ...fake, executor };
}

const verdictFor = (effect: Effect, policy: PolicyContext, tainted: boolean) =>
	decide({ ...policy, effect, taint: { untrustedReadInRun: tainted, argsCarryUntrusted: false }, action: { toolName: `probe_${effect}` }, now: new Date("2026-11-05T12:00:00Z") } satisfies DecideInput);

describe("B. sem grant válido, efeito de alto risco não executa quando decide pede aprovação", () => {
	const cases = EFFECT_CLASSES.flatMap((effect) =>
		SURFACES.flatMap((surface) => AUTONOMIES.flatMap((autonomy) => [true, false].flatMap((ownerPresent) => [false, true].map((tainted) => ({ effect, surface, autonomy, ownerPresent, tainted }))))),
	);

	it("cobre todas as classes x superfícies x autonomias", () => {
		expect(cases.length).toBe(EFFECT_CLASSES.length * SURFACES.length * AUTONOMIES.length * 4);
	});

	it("a propriedade vale em todas as combinações", async () => {
		const seen = { approve: 0, run: 0, hidden: 0 };
		for (const c of cases) {
			const policy: PolicyContext = { surface: c.surface, ownerPresent: c.ownerPresent, autonomy: c.autonomy, rules: [] };
			const verdict = verdictFor(c.effect, policy, c.tainted);
			const counter: Counter = { runs: 0 };
			const tool = probeTool(c.effect, counter);
			const label = JSON.stringify(c);

			// Sem grant: só roda se o decide mandou rodar.
			const bare = executorFor(policy, c.tainted);
			const first = await bare.executor.executeCall({ callId: "c1", step: 0, tool, args: {} });
			if (verdict.kind === "approve") {
				seen.approve++;
				expect(first.status, label).toBe("pending_approval");
				expect(counter.runs, label).toBe(0);
				expect(bare.journal.entries, label).toEqual([]);
			} else if (verdict.kind === "hidden") {
				seen.hidden++;
				expect(first.status, label).toBe("not_available");
				expect(counter.runs, label).toBe(0);
			} else {
				seen.run++;
				expect(first.status, label).toBe("ok");
				expect(counter.runs, label).toBe(1);
			}

			// Sem regras nem mandato, send/money/public_link/destructive nunca rodam sozinhos.
			if (c.effect === "send" || c.effect === "money" || c.effect === "public_link" || c.effect === "destructive") expect(verdict.kind, label).not.toBe("run");
			if (HIGH_RISK.includes(c.effect) && verdict.kind === "run") expect(c.effect === "write_external" && c.autonomy === "autonomous" && !c.tainted && c.ownerPresent, label).toBe(true);

			if (verdict.kind !== "approve") continue;

			// Grants inválidos: de outro pedido, com hash errado, e o reuso. Nenhum executa.
			counter.runs = 0;
			const ex = executorFor(policy, c.tainted);
			const pending = await ex.executor.executeCall({ callId: "c1", step: 0, tool, args: {} });
			if (pending.status !== "pending_approval") throw new Error(label);
			const good = grantApproval(pending.request, ex.clock.now());
			const forged: ApprovalGrant[] = [
				{ ...good, requestId: "outro-pedido" },
				{ ...good, payloadHash: "0".repeat(64) },
			];
			for (const grant of forged) {
				const out = await ex.executor.executeCall({ callId: "c1", step: 0, tool, args: {}, grant });
				expect(out.status, label).toBe("approval_invalid");
			}
			// Argumentos mudaram depois da aprovação: o grant antigo não vale para a chamada nova.
			const changed = await ex.executor.executeCall({ callId: "c1", step: 0, tool, args: { to: "outra@example.com" }, grant: good });
			expect(changed.status, label).toBe("approval_invalid");
			expect(counter.runs, label).toBe(0);

			// Grant válido: executa uma vez; o mesmo grant não vale de novo.
			const ok = await ex.executor.executeCall({ callId: "c1", step: 0, tool, args: {}, grant: good });
			expect(ok.status, label).toBe("ok");
			expect(counter.runs, label).toBe(1);
			const again = await ex.executor.executeCall({ callId: "c2", step: 1, tool, args: {}, grant: good });
			expect(again.status === "approval_invalid" || again.status === "pending_approval", label).toBe(true);
			expect(counter.runs, label).toBe(1);
		}
		// A matriz exercitou os três veredictos (senão o teste não prova nada).
		expect(seen.approve).toBeGreaterThan(50);
		expect(seen.run).toBeGreaterThan(0);
		expect(seen.hidden).toBeGreaterThan(0);
	});

	// Paridade entre superfícies (cláusula 16), com a tabela ESCRITA À MÃO a partir do contrato (06): não usa `decide` para
	// montar a expectativa, então uma regressão em `decide` não se aprova sozinha. Dono presente, sem taint.
	type V = "approve" | "hidden" | "run";
	const OWNER_SURFACES = ["chat", "api"] as const;
	const NO_OWNER = ["agenda", "routine", "subagent", "bot_to_bot"] as const;
	const critical = (owner: V, noOwner: V): Record<(typeof SURFACES)[number], V> => ({ chat: owner, api: owner, agenda: noOwner, routine: noOwner, subagent: noOwner, bot_to_bot: noOwner });
	const PARITY: Record<Effect, Record<AutonomyName, Record<(typeof SURFACES)[number], V>>> = {
		read: { always_ask: critical("run", "run"), balanced: critical("run", "run"), autonomous: critical("run", "run") },
		draft: { always_ask: critical("run", "run"), balanced: critical("run", "run"), autonomous: critical("run", "run") },
		write_internal: { always_ask: critical("approve", "approve"), balanced: critical("run", "run"), autonomous: critical("run", "run") },
		write_external: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("run", "hidden") },
		send: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("approve", "hidden") },
		money: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("approve", "hidden") },
		public_link: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("approve", "hidden") },
		credential: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("approve", "hidden") },
		destructive: { always_ask: critical("approve", "hidden"), balanced: critical("approve", "hidden"), autonomous: critical("approve", "hidden") },
	};
	const STATUS_OF: Record<V, string> = { approve: "pending_approval", hidden: "not_available", run: "ok" };

	it("paridade de superfícies: a tabela literal vale para `decide` e para o executor (auditoria F1, T6)", async () => {
		expect([...OWNER_SURFACES, ...NO_OWNER].sort()).toEqual([...SURFACES].sort());
		let checked = 0;
		for (const effect of EFFECT_CLASSES) {
			for (const autonomy of AUTONOMIES) {
				for (const surface of SURFACES) {
					const want = PARITY[effect][autonomy][surface];
					const policy: PolicyContext = { surface, ownerPresent: true, autonomy, rules: [] };
					const label = JSON.stringify({ effect, autonomy, surface });
					expect(verdictFor(effect, policy, false).kind, label).toBe(want);
					const counter: Counter = { runs: 0 };
					const out = await executorFor(policy, false).executor.executeCall({ callId: "c1", step: 0, tool: probeTool(effect, counter), args: {} });
					expect(out.status, label).toBe(STATUS_OF[want]);
					expect(counter.runs, label).toBe(want === "run" ? 1 : 0);
					checked++;
				}
			}
		}
		expect(checked).toBe(EFFECT_CLASSES.length * AUTONOMIES.length * SURFACES.length);
	});

	it("paridade com taint e sem dono: leitura não confiável tira o 'run' de envio/escrita externa/link; dono ausente esconde o que é só do dono (auditoria F1, T6)", async () => {
		const taintedExpect: Partial<Record<Effect, V>> = { write_external: "approve", send: "approve", public_link: "approve", write_internal: "run", read: "run" };
		for (const [effect, want] of Object.entries(taintedExpect) as Array<[Effect, V]>) {
			for (const surface of OWNER_SURFACES) {
				const policy: PolicyContext = { surface, ownerPresent: true, autonomy: "autonomous", rules: [] };
				expect(verdictFor(effect, policy, true).kind, `${effect}/${surface}`).toBe(want);
			}
		}
		for (const effect of ["send", "money", "public_link", "credential", "destructive", "write_external"] as const) {
			for (const surface of OWNER_SURFACES) {
				const policy: PolicyContext = { surface, ownerPresent: false, autonomy: "autonomous", rules: [] };
				expect(verdictFor(effect, policy, false).kind, `${effect}/${surface}`).toBe("hidden");
			}
		}
	});

	it("regra do dono 'run' nunca solta send/money/public_link/destructive", async () => {
		for (const effect of ["send", "money", "public_link", "destructive"] as const) {
			const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [{ match: "*", verdict: "run" }] };
			const counter: Counter = { runs: 0 };
			const ex = executorFor(policy, false);
			const out = await ex.executor.executeCall({ callId: "c1", step: 0, tool: probeTool(effect, counter), args: {} });
			expect(out.status, effect).toBe("pending_approval");
			expect(counter.runs, effect).toBe(0);
		}
	});
});

// ---------------------------------------------------------------- C. handoff nunca executa

describe("C. handoff nunca executa", () => {
	it("em toda superfície, autonomia, regra 'run' e até com grant forjado", async () => {
		let checked = 0;
		for (const kind of HANDOFF_ACTIONS) {
			for (const effect of EFFECT_CLASSES) {
				for (const surface of SURFACES) {
					for (const autonomy of AUTONOMIES) {
						for (const ownerPresent of [true, false]) {
							const policy: PolicyContext = { surface, ownerPresent, autonomy, rules: [{ match: "*", verdict: "run" }] };
							const counter: Counter = { runs: 0 };
							const tool = probeTool(effect, counter, kind);
							const ex = executorFor(policy, false);
							const forged: ApprovalGrant = { requestId: "x", payloadHash: "y", grantedAt: ex.clock.now() };
							for (const grant of [undefined, forged]) {
								const out = await ex.executor.executeCall({ callId: "c1", step: 0, tool, args: {}, ...(grant && { grant }) });
								const label = JSON.stringify({ kind, effect, surface, autonomy, ownerPresent, grant: !!grant });
								expect(out.status, label).toBe("handoff");
								expect(counter.runs, label).toBe(0);
								expect(ex.journal.entries, label).toEqual([]);
								checked++;
							}
						}
					}
				}
			}
		}
		expect(checked).toBe(HANDOFF_ACTIONS.length * EFFECT_CLASSES.length * SURFACES.length * AUTONOMIES.length * 2 * 2);
	});

	it("no kernel, o handoff estaciona o run e a tool não roda", async () => {
		const counter: Counter = { runs: 0 };
		const tool = probeTool("credential", counter, "change_password");
		const h = kernelHarness([reply({ calls: [call("p1", tool.name, {})] }), reply({ text: "ok" })], { tools: [tool] });
		const out = await h.run({ policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] } });
		expect(out.status).toBe("parked");
		expect(counter.runs).toBe(0);
	});
});

// ---------------------------------------------------------------- D. segredo nunca vaza

describe("D. segredo do cofre nunca aparece", () => {
	// Tem formato de token de verdade (o redator conhece o padrão) e é única para a varredura.
	const SECRET = "gh" + "p_SEGREDO0DO0COFRE0QUE0NAO0PODE0VAZAR0000"; // montado por concatenação: a higiene não deve ver um token no arquivo
	const vault: Vault = {
		listHandles: async () => [{ id: "h1", label: "Conta de teste" }],
		resolve: async (_user, id) => (id === "h1" ? { reveal: () => SECRET } : null),
	};

	/** Tool que resolve o segredo pelo handle, USA o valor e, de propósito, o deixa escapar em todo canal de saída. */
	function leakyTool(): Tool {
		return defineTool({
			name: "login_account",
			description: "Log in with a stored credential handle.",
			inputSchema: z.object({ handle: z.string() }),
			effect: "write_internal",
			execute: async ({ handle }, ctx) => {
				const value = await ctx.ports.vault.resolve(ctx.ownerId, handle);
				if (!value) return { ok: false, error: "unknown handle" };
				const secret = value.reveal();
				return { ok: true, summary: `logged in with ${secret}`, receipt: { what: `Login com ${secret}`, where: `https://example.com/?k=${secret}` } };
			},
		});
	}

	it("numa execução roteirizada do kernel, nada capturado contém o valor", async () => {
		const h = kernelHarness([reply({ calls: [call("l1", "login_account", { handle: "h1" })] }), reply({ text: "entrei" })], { tools: [leakyTool()] });
		(h.ports as unknown as { vault: Vault }).vault = vault;
		const out = await h.run({ policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] } });
		expect(out.status).toBe("done");
		const captured = {
			events: h.log.events,
			journal: h.journal.entries,
			receipts: h.receipts.items,
			modelRequests: h.llm.requests,
			checkpoints: [...h.runs.checkpoints.values()],
			notes: [...h.notes.items.values()],
			result: out,
		};
		const dump = JSON.stringify(captured);
		expect(dump.length).toBeGreaterThan(500); // a varredura leu algo de verdade
		expect(h.log.of("tool_result")).toHaveLength(1); // a tool rodou e o resultado passou pelo caminho normal
		expect(dump).not.toContain(SECRET);
		expect(dump).not.toContain("SEGREDO0DO0COFRE");
	});

	it("valor sem formato reconhecível: o executor redige o que o cofre declara usado", async () => {
		const plain = "correct-horse-battery-staple-9137";
		const fake = fakePorts();
		(fake.ports as unknown as { vault: Vault }).vault = { ...vault, resolve: async () => ({ reveal: () => plain }) };
		const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] };
		const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: fake.ports, hash, policy, secrets: () => [plain] });
		const tool = leakyTool();
		const out = await executor.executeCall({ callId: "c1", step: 0, tool, args: { handle: "h1" } });
		expect(out.status).toBe("ok");
		expect(JSON.stringify({ out, journal: fake.journal.entries, receipts: fake.receipts.items })).not.toContain(plain);
	});

	// Ligação kernel → executor (F1.12): o cofre entregue às tools é rastreado e os valores resolvidos
	// alimentam o `secrets` do executor. Aqui o segredo NÃO tem formato de token.
	it("kernel: valor resolvido pelo Vault sem formato conhecido nunca chega a evento, journal, recibo, mensagem nem checkpoint", async () => {
		const plain = "correct-horse-battery-staple-9137";
		const plainVault: Vault = { listHandles: async () => [], resolve: async (_u, id) => (id === "h1" ? { reveal: () => plain } : null) };
		const leaky = (name: string, extra: Partial<Parameters<typeof defineTool>[0]> = {}) =>
			defineTool({
				name,
				description: "Log in with a stored credential handle.",
				inputSchema: z.object({ handle: z.string() }),
				effect: "write_internal",
				...extra,
				execute: async ({ handle }: { handle: string }, ctx) => {
					const value = await ctx.ports.vault.resolve(ctx.ownerId, handle);
					if (!value) return { ok: false, error: "unknown handle" };
					const secret = value.reveal();
					return { ok: true, summary: `logged in with ${secret}`, receipt: { what: `Login com ${secret}`, where: `https://example.com/?k=${secret}` } };
				},
			} as Parameters<typeof defineTool>[0]);
		const h = kernelHarness(
			[reply({ calls: [call("l1", "login_account", { handle: "h1" }), call("l2", "login_remote", { handle: "h1" })] }), reply({ text: "entrei" })],
			{ tools: [leaky("login_account"), leaky("login_remote", { trust: "untrusted", source: "web" })] },
		);
		(h.ports as unknown as { vault: Vault }).vault = plainVault;
		const out = await h.run({ policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] } });
		expect(out.status).toBe("done");
		expect(h.log.of("tool_result")).toHaveLength(2);
		const dump = JSON.stringify({ events: h.log.events, journal: h.journal.entries, receipts: h.receipts.items, modelRequests: h.llm.requests, checkpoints: [...h.runs.checkpoints.values()], notes: [...h.notes.items.values()], result: out });
		expect(dump.length).toBeGreaterThan(500);
		expect(dump).not.toContain(plain);
		expect(dump).toContain("[redacted]");
	});
});
