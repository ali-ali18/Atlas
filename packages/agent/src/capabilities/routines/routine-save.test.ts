// F9 parte 2: `routine_create`, `routine_update`, `routine_webhook_info`, `suggest_routine`, `report_alert`, `notify_user`.
import { describe, expect, it } from "vitest";
import { createExecutor, grantApproval, type ExecutorDeps } from "../../contract/index.js";
import type { Ports } from "../../ports/index.js";
import { chatPolicy } from "../../testing/contract-helpers.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import { FakeRoutines, sampleRoutines } from "../../testing/routines-fakes.js";
import { FakeVault, TEST_LOGIN_PASSWORD, type FakeVaultItem } from "../../testing/vault-fakes.js";
import { createRoutineRunCapability, createRoutinesCapability } from "./index.js";

const ITEMS: FakeVaultItem[] = [
	{ owner: "owner-1", id: "banco", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco.example", username: "dono@exemplo.test" },
	{ owner: "owner-1", id: "sem-site", kind: "login", password: TEST_LOGIN_PASSWORD, username: "x" },
	{ owner: "owner-2", id: "banco-do-b", kind: "login", password: TEST_LOGIN_PASSWORD, site: "banco-b.example", username: "b" },
];
const routinePolicy: ExecutorDeps["policy"] = { surface: "routine", ownerPresent: false, autonomy: "balanced", rules: [] };

function rig(opts: { ownerId?: string; withVault?: boolean; policy?: ExecutorDeps["policy"] } = {}) {
	const routines = new FakeRoutines(sampleRoutines(), []);
	const vault = new FakeVault(ITEMS);
	const f = fakePorts();
	const capability = createRoutinesCapability({ routines, ...(opts.withVault !== false && { vault }) });
	const tool = (name: string) => {
		const found = capability.tools.find((t) => t.name === name);
		if (!found) throw new Error(`tool ${name} ausente`);
		return found;
	};
	const executor = createExecutor({ runId: "run-1", ownerId: opts.ownerId ?? "owner-1", ports: f.ports as unknown as Ports, hash: sha256, policy: opts.policy ?? chatPolicy });
	const run = (name: string, args: unknown) => executor.executeCall({ callId: "c1", step: 1, tool: tool(name), args });
	const approved = async (name: string, args: unknown) => {
		const pending = await run(name, args);
		if (pending.status !== "pending_approval") return pending;
		return executor.executeCall({ callId: "c1", step: 1, tool: tool(name), args, grant: grantApproval(pending.request, f.clock.now()) });
	};
	return { routines, f, capability, tool, run, approved };
}

const text = (out: { status: string }) => JSON.stringify(out);
const create = { name: "Conferir o estoque", task: "Confere o estoque da canela e resume.", triggerType: "cron", schedule: "0 9 * * 1-5" } as const;
const lastCall = (r: ReturnType<typeof rig>, method: string) => r.routines.calls.filter((c) => c.method === method).at(-1);

describe("routine_create: gatilho validado", () => {
	it("cron válido cria sem pedir aprovação (escrita interna que desfaz) e diz o que ficou", async () => {
		const r = rig();
		const out = await r.run("routine_create", create);
		expect(out.status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ name: "Conferir o estoque", trigger: { kind: "cron", schedule: "0 9 * * 1-5" }, timezone: "America/Sao_Paulo", enabled: true });
		expect(text(out)).toContain("routine card is already shown");
	});

	it("uma vez: runAt no futuro vira horário ISO; inMinutes soma ao relógio do run; os dois juntos, passado ou nenhum recusam", async () => {
		const r = rig();
		const now = r.f.clock.now().getTime();
		const future = new Date(now + 3 * 86_400_000).toISOString();
		expect((await r.run("routine_create", { name: "Aluguel", task: "Avisa.", triggerType: "once", runAt: future })).status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ trigger: { kind: "once", runAt: future } });
		expect((await r.run("routine_create", { name: "Daqui a pouco", task: "Avisa.", triggerType: "once", inMinutes: 90 })).status).toBe("ok");
		expect((lastCall(r, "create")?.args[0] as { trigger: { runAt: string } }).trigger.runAt).toBe(new Date(now + 90 * 60_000).toISOString());
		for (const bad of [{ runAt: future, inMinutes: 10 }, { runAt: "2020-01-01T10:00" }, {}]) {
			const out = await r.run("routine_create", { name: "Ruim", task: "x", triggerType: "once", ...bad });
			expect(out.status).toBe("error");
		}
	});

	it("cron inválido, intervalo fora de 5 a 1440, github sem eventos e campo de outro tipo falham com o que é aceito", async () => {
		const r = rig();
		expect(text(await r.run("routine_create", { ...create, schedule: "todo dia" }))).toContain("5-field cron");
		expect(text(await r.run("routine_create", { ...create, schedule: undefined }))).toContain("cron needs schedule");
		expect(text(await r.run("routine_create", { name: "I", task: "x", triggerType: "interval", everyMinutes: 3 }))).toMatch(/mínimo|5 minutos/);
		expect(text(await r.run("routine_create", { name: "I", task: "x", triggerType: "interval", everyMinutes: 5000 }))).toMatch(/máximo|1440/);
		expect(text(await r.run("routine_create", { name: "G", task: "x", triggerType: "github" }))).toContain("github needs");
		expect(text(await r.run("routine_create", { name: "G", task: "x", triggerType: "github", github: { repo: "acme/site", events: ["nao_existe"] } }))).toContain("Invalid arguments");
		const stray = text(await r.run("routine_create", { name: "S", task: "x", triggerType: "cron", schedule: "0 9 * * *", everyMinutes: 60 }));
		expect(stray).toContain("does not belong to triggerType cron");
		expect(text(await r.run("routine_create", { ...create, segredo: "x" }))).toContain("Unknown field(s)");
		expect(text(await r.run("routine_create", { ...create, timezone: "Marte/Olimpo" }))).toContain("IANA timezone");
		expect(r.routines.calls.some((c) => c.method === "create")).toBe(false);
	});

	it("intervalo comum de 50 minutos é aceito (monitorar PR); GitHub e e-mail passam pela validação de verdade", async () => {
		const r = rig();
		expect((await r.run("routine_create", { name: "PR", task: "x", triggerType: "interval", everyMinutes: 50 })).status).toBe("ok");
		expect((await r.run("routine_create", { name: "Push", task: "x", triggerType: "github", github: { repo: "https://github.com/acme/site", events: ["push"], branch: "main" } })).status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ trigger: { kind: "github", repo: "acme/site", events: ["push"], branch: "main" } });
		expect((await r.run("routine_create", { name: "NF", task: "x", triggerType: "email", email: { fromContains: "@fornecedor.com" } })).status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ trigger: { kind: "email", fromContains: "@fornecedor.com" } });
	});

	it("o mesmo nome de uma rotina existente recusa e manda usar routine_update (nunca duplica nem edita às escondidas)", async () => {
		const r = rig();
		const out = await r.run("routine_create", { ...create, name: "resumo da manhã" });
		expect(out.status).toBe("error");
		expect(text(out)).toContain("routine_update");
		expect(r.routines.calls.some((c) => c.method === "create")).toBe(false);
	});
});

describe("routine_create: alerta e intervalo mínimo de 2 h", () => {
	const alert = { condition: "o estoque da canela cair abaixo de 10" };
	it("alerta por intervalo abaixo de 120 min sem pedido explícito recusa; com frequent:true ou >= 120 passa", async () => {
		const r = rig();
		const tooOften = await r.run("routine_create", { name: "Estoque", task: "x", triggerType: "interval", everyMinutes: 30, alert });
		expect(tooOften.status).toBe("error");
		expect(text(tooOften)).toContain("under 120 minutes");
		expect(r.routines.calls.some((c) => c.method === "create")).toBe(false);
		expect((await r.run("routine_create", { name: "Estoque", task: "x", triggerType: "interval", everyMinutes: 30, alert: { ...alert, frequent: true } })).status).toBe("ok");
		expect((await r.run("routine_create", { name: "Estoque 2", task: "x", triggerType: "interval", everyMinutes: 120, alert })).status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ alert: { condition: alert.condition } });
		// `frequent` é só o pedido do dono: não vai gravado no alerta.
		expect(JSON.stringify(lastCall(r, "create")?.args[0])).not.toContain("frequent");
	});

	it("alerta só com cron ou intervalo; com uma vez, GitHub ou e-mail recusa", async () => {
		const r = rig();
		const out = await r.run("routine_create", { name: "Aviso", task: "x", triggerType: "once", inMinutes: 60, alert });
		expect(out.status).toBe("error");
		expect(text(out)).toContain("cron or interval");
		expect((await r.run("routine_create", { name: "Aviso 2", task: "x", triggerType: "cron", schedule: "0 10,14 * * 1-5", alert })).status).toBe("ok");
	});
});

describe("routine_create: webhook e segredo", () => {
	it("devolve só o endereço e diz que o segredo não é mostrado; nada de segredo no resultado", async () => {
		const r = rig();
		const out = await r.run("routine_create", { name: "Formulário", task: "Trata o envio.", triggerType: "webhook" });
		expect(out.status).toBe("ok");
		expect(text(out)).toContain("https://atlas.test/hooks/");
		expect(text(out)).toContain("secret is not shown");
	});
	it("routine_webhook_info lista o endereço (sem segredo) e B não vê o de A", async () => {
		const r = rig();
		await r.run("routine_create", { name: "Formulário", task: "x", triggerType: "webhook" });
		const mine = text(await r.run("routine_webhook_info", {}));
		expect(mine).toContain("Formulário");
		expect(mine).toContain("https://atlas.test/hooks/");
		expect(mine).toContain("secret not shown");
		expect(text(await rig({ ownerId: "owner-2" }).run("routine_webhook_info", {}))).toContain("No routine with a webhook");
	});
});

describe("permissão de login da rotina (decisão do dono, 09/11)", () => {
	const withLogin = { ...create, loginAccess: { login: "banco", site: "https://www.banco.example/entrar" } };

	it("declarar o login pede o cartão de aprovação (credential, em qualquer autonomia) mostrando login e site; nada é criado antes", async () => {
		const r = rig();
		expect(r.tool("routine_create").effectFor(withLogin)).toBe("credential");
		expect(r.tool("routine_create").effectFor(create)).toBe("write_internal");
		const pending = await r.run("routine_create", withLogin);
		expect(pending.status).toBe("pending_approval");
		const facts = (pending as unknown as { request: { effect: string; riskFacts: { target: string } } }).request;
		expect(facts.effect).toBe("credential");
		expect(facts.riskFacts.target).toContain("o login banco para entrar em banco.example nesta rotina");
		expect(r.routines.calls.some((c) => c.method === "create")).toBe(false);
	});

	it("aprovado, a rotina guarda login + site NORMALIZADO; o resumo diz que só vale ali", async () => {
		const r = rig();
		const out = await r.approved("routine_create", withLogin);
		expect(out.status).toBe("ok");
		expect(lastCall(r, "create")?.args[0]).toMatchObject({ loginAccess: { login: "banco", site: "banco.example" } });
		expect(text(out)).toContain("sign in to banco.example");
	});

	it("login que não existe, sem site salvo, de outro site ou do OUTRO dono é recusado com o motivo (B não usa o login de A)", async () => {
		const r = rig();
		for (const [access, expected] of [
			[{ login: "nao-existe", site: "banco.example" }, /No saved login/],
			[{ login: "sem-site", site: "banco.example" }, /no saved site/],
			[{ login: "banco", site: "outro.example" }, /belongs to banco\.example, not to outro\.example/],
		] as const) {
			const out = await r.approved("routine_create", { ...create, loginAccess: access });
			expect(out.status).toBe("error");
			expect(text(out)).toMatch(expected);
		}
		const b = rig({ ownerId: "owner-2" });
		const out = await b.approved("routine_create", withLogin);
		expect(out.status).toBe("error");
		expect(text(out)).toContain("No saved login");
		expect(b.routines.calls.some((c) => c.method === "create")).toBe(false);
	});

	it("sem cofre no run a permissão não é aceita (nada de confiar no que o modelo declarou)", async () => {
		const r = rig({ withVault: false });
		const out = await r.approved("routine_create", withLogin);
		expect(out.status).toBe("error");
		expect(text(out)).toContain("vault is not available");
	});

	it("editar: login novo pede aprovação; tirar a permissão (null) não pede; login que o modelo não declarou fica como está", async () => {
		const r = rig();
		expect(r.tool("routine_update").effectFor({ target: "Resumo da manhã", loginAccess: { login: "banco", site: "banco.example" } })).toBe("credential");
		expect(r.tool("routine_update").effectFor({ target: "Resumo da manhã", loginAccess: null })).toBe("write_internal");
		const out = await r.approved("routine_update", { target: "Resumo da manhã", loginAccess: { login: "banco", site: "banco.example" } });
		expect(out.status).toBe("ok");
		expect(lastCall(r, "update")?.args[1]).toMatchObject({ loginAccess: { login: "banco", site: "banco.example" } });
		const removed = await r.run("routine_update", { target: "Resumo da manhã", loginAccess: null });
		expect(removed.status).toBe("ok");
		expect(lastCall(r, "update")?.args[1]).toEqual({ loginAccess: null });
		await r.run("routine_update", { target: "Resumo da manhã", task: "Outra instrução." });
		expect(lastCall(r, "update")?.args[1]).toEqual({ task: "Outra instrução." });
	});

	// C2 da auditoria F9: a permissão aprovada é para ESTA instrução neste gatilho. Trocar qualquer um dos dois (ou o painel) a apaga.
	const withPermission = () => {
		const r = rig();
		r.routines.rows.find((x) => x.id === "r1")!.loginAccess = { login: "banco", site: "banco.example" };
		return r;
	};

	it("trocar a instrução, o gatilho ou o painel de rotina com login APAGA a permissão e o resultado manda pedir de novo ao dono", async () => {
		for (const change of [{ task: "Outra instrução." }, { triggerType: "interval", everyMinutes: 240 }, { panelId: "p9" }]) {
			const r = withPermission();
			const out = await r.run("routine_update", { target: "Resumo da manhã", ...change });
			expect(out.status).toBe("ok");
			expect(lastCall(r, "update")?.args[1]).toMatchObject({ loginAccess: null });
			expect(r.routines.rows.find((x) => x.id === "r1")?.loginAccess).toBeUndefined();
			expect(text(out)).toContain("login permission was removed");
			expect(text(out)).toContain("ask the owner");
		}
	});

	it("mudanças que não alteram o que a rotina faz (nome, grupo, aviso, pausar) mantêm a permissão", async () => {
		const r = withPermission();
		const out = await r.run("routine_update", { target: "Resumo da manhã", name: "Resumo novo", group: "Casa", notify: "important", enabled: false });
		expect(out.status).toBe("ok");
		expect(lastCall(r, "update")?.args[1]).not.toHaveProperty("loginAccess");
		expect(r.routines.rows.find((x) => x.id === "r1")?.loginAccess).toEqual({ login: "banco", site: "banco.example" });
	});

	it("conceder permissão exige o nome inteiro ou o id da rotina (pedaço de nome é recusado) e o cartão mostra rotina, gatilho e instrução", async () => {
		const r = rig();
		const grant = { login: "banco", site: "banco.example" };
		const partial = await r.approved("routine_update", { target: "manhã", loginAccess: grant });
		expect(partial.status).toBe("error");
		expect(text(partial)).toContain("exact name or id");
		expect(r.routines.calls.some((c) => c.method === "update")).toBe(false);
		const pending = await r.run("routine_update", { target: "Resumo da manhã", task: "x".repeat(400), loginAccess: grant });
		expect(pending.status).toBe("pending_approval");
		const target = (pending as unknown as { request: { riskFacts: { target: string } } }).request.riskFacts.target;
		expect(target).toContain("o login banco para entrar em banco.example");
		expect(target).toContain("Resumo da manhã");
		expect(target).toContain("x".repeat(100));
		expect(target.length).toBeLessThan(500);
		const same = await r.run("routine_update", { target: "r1", loginAccess: grant });
		const current = (same as unknown as { request: { riskFacts: { target: string } } }).request.riskFacts.target;
		expect(current).toContain("todo dia às 8h");
		expect(current).toContain("Resume os e-mails importantes.");
	});

	it("criar com login: o cartão mostra o nome da rotina, o gatilho em frase e a instrução", async () => {
		const r = rig();
		const pending = await r.run("routine_create", withLogin);
		const target = (pending as unknown as { request: { riskFacts: { target: string } } }).request.riskFacts.target;
		expect(target).toContain("Conferir o estoque");
		expect(target).toContain("Confere o estoque da canela e resume.");
		expect(target).toMatch(/dias úteis|segunda/i);
	});

	it("sem dono presente a criação e a edição nem existem (readOnly) e, mesmo declarada, a política esconde o efeito de credencial", async () => {
		const readOnly = createRoutinesCapability({ routines: new FakeRoutines(sampleRoutines(), []), readOnly: true });
		expect(readOnly.tools.map((t) => t.name)).toEqual(["routine_list"]);
		const r = rig({ policy: routinePolicy });
		const out = await r.run("routine_create", withLogin);
		expect(out.status).toBe("not_available");
		expect(r.routines.calls.some((c) => c.method === "create")).toBe(false);
	});
});

describe("routine_update", () => {
	it("muda o que foi pedido e o resto fica; devolve o resumo da rotina", async () => {
		const r = rig();
		const out = await r.run("routine_update", { target: "Resumo da manhã", name: "Resumo novo", triggerType: "interval", everyMinutes: 240, panelId: "p1", group: "Casa", notify: "important" });
		expect(out.status).toBe("ok");
		expect(lastCall(r, "update")?.args[1]).toEqual({ name: "Resumo novo", trigger: { kind: "interval", everyMinutes: 240 }, panelId: "p1", group: "Casa", notify: "important" });
		expect(text(out)).toContain("routine card was updated");
	});

	it("gatilho sem triggerType, nada para mudar, nome parecido ambíguo e alvo inexistente falham com a dica", async () => {
		const r = rig();
		expect(text(await r.run("routine_update", { target: "Resumo da manhã", everyMinutes: 60 }))).toContain("given without triggerType");
		expect(text(await r.run("routine_update", { target: "Resumo da manhã" }))).toContain("Nothing to change");
		expect(text(await r.run("routine_update", { target: "a", name: "X" }))).toContain("More than one routine");
		expect(text(await r.run("routine_update", { target: "não existe", name: "X" }))).toContain("No routine matches");
		expect(text(await r.run("routine_update", { target: "Resumo da manhã", name: "Alerta do estoque" }))).toContain("already named");
		expect(r.routines.calls.some((c) => c.method === "update")).toBe(false);
	});

	it("alerta: o piso de 2 h vale na edição; alerta numa rotina de uma vez recusa; alert null volta a rotina comum", async () => {
		const r = rig();
		const alert = { condition: "o estoque cair abaixo de 10" };
		expect(text(await r.run("routine_update", { target: "Resumo da manhã", triggerType: "interval", everyMinutes: 30, alert }))).toContain("under 120 minutes");
		expect(text(await r.run("routine_update", { target: "Lembrar do aluguel", alert }))).toContain("cron or interval");
		expect(text(await r.run("routine_update", { target: "Alerta do estoque", triggerType: "once", inMinutes: 30 }))).toContain("must stay cron or interval");
		expect((await r.run("routine_update", { target: "Alerta do estoque", alert: null })).status).toBe("ok");
		expect(lastCall(r, "update")?.args[1]).toEqual({ alert: null });
	});

	it("dono B não edita a rotina de A: not found, nada muda", async () => {
		const b = rig({ ownerId: "owner-2" });
		const out = await b.run("routine_update", { target: "r1", name: "Hackeada" });
		expect(out.status).toBe("error");
		expect(text(out)).toContain("No routine matches");
		expect(b.routines.rows.find((x) => x.id === "r1")?.name).toBe("Resumo da manhã");
		expect(b.routines.calls.some((c) => c.method === "update")).toBe(false);
	});
});

describe("suggest_routine", () => {
	const idea = { name: "Resumo da semana", task: "Resumir as vendas da semana.", cron: "0 8 * * 1" };
	it("vira cartão de pergunta (não cria) e diz isso; modo automático diz que criou com desfazer", async () => {
		const r = rig();
		const out = await r.run("suggest_routine", idea);
		expect(out.status).toBe("ok");
		expect(text(out)).toContain("Nothing exists yet");
		expect(lastCall(r, "suggest")?.args[0]).toMatchObject({ name: "Resumo da semana", trigger: { kind: "cron", schedule: "0 8 * * 1" } });
		r.routines.suggestOutcome = { status: "created" };
		expect(text(await r.run("suggest_routine", { ...idea, name: "Outra ideia" }))).toContain("Undo");
	});
	it("ideia do bot nunca é mais frequente que 2 h; cron e intervalo juntos, nenhum dos dois ou cron inválido recusam", async () => {
		const r = rig();
		expect(text(await r.run("suggest_routine", { name: "x", task: "y", everyMinutes: 30 }))).toContain("every 2 hours or less often");
		expect((await r.run("suggest_routine", { name: "x", task: "y", everyMinutes: 240 })).status).toBe("ok");
		expect(text(await r.run("suggest_routine", { ...idea, everyMinutes: 240 }))).toContain("not both");
		expect(text(await r.run("suggest_routine", { name: "x", task: "y" }))).toContain("cron (5 fields) or everyMinutes");
		expect(text(await r.run("suggest_routine", { ...idea, cron: "diário" }))).toContain("5-field cron");
	});
	it("duplicada, já proposta e modo proativo desligado voltam como erro com o motivo (nunca sucesso falso)", async () => {
		const r = rig();
		r.routines.suggestOutcome = { status: "duplicate_routine", routine: "Resumo da manhã" };
		expect(text(await r.run("suggest_routine", idea))).toContain("similar routine already exists");
		r.routines.suggestOutcome = { status: "already_proposed", proposal: "declined" };
		expect(text(await r.run("suggest_routine", idea))).toContain("already offered");
		r.routines.suggestOutcome = null;
		expect(text(await r.run("suggest_routine", idea))).toContain("Proactive mode is off");
	});
});

describe("run de rotina: report_alert e notify_user", () => {
	function runRig(parts: Parameters<typeof createRoutineRunCapability>[0]) {
		const capability = createRoutineRunCapability(parts);
		const f = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: f.ports as unknown as Ports, hash: sha256, policy: routinePolicy });
		const run = (name: string, args: unknown) => executor.executeCall({ callId: "c1", step: 1, tool: capability.tools.find((t) => t.name === name)!, args });
		return { capability, run };
	}
	it("o alerta recebe só report_alert (núcleo); o veredito é gravado uma vez e valida os args", async () => {
		const verdicts: unknown[] = [];
		const r = runRig({ alert: { record: (v) => (verdicts.length > 0 ? "already_reported" : (verdicts.push(v), "recorded")) }, push: { send: async () => ({ sent: true }) } });
		expect(r.capability.core).toBe(true);
		expect(r.capability.tools.map((t) => t.name)).toEqual(["report_alert"]);
		expect((await r.run("report_alert", { triggered: "sim", summary: "x" })).status).toBe("error");
		expect((await r.run("report_alert", { triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" })).status).toBe("ok");
		expect(verdicts).toEqual([{ triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" }]);
		expect(text(await r.run("report_alert", { triggered: false, summary: "de novo" }))).toContain("already recorded");
	});
	it("rotina 'só importante' recebe notify_user; a trava de um por run e de silêncio vem do servidor", async () => {
		const answers = [{ sent: true as const }, { sent: false as const, reason: "one_per_run" as const }, { sent: false as const, reason: "quiet_hours" as const }];
		const r = runRig({ push: { send: async () => answers.shift()! } });
		expect(r.capability.tools.map((t) => t.name)).toEqual(["notify_user"]);
		expect((await r.run("notify_user", { message: "Estoque baixo agora." })).status).toBe("ok");
		expect(text(await r.run("notify_user", { message: "de novo" }))).toContain("already sent");
		expect(text(await r.run("notify_user", { message: "madrugada" }))).toContain("quiet hours");
		expect((await r.run("notify_user", { message: "x".repeat(300) })).status).toBe("error");
	});
});
