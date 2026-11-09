import { describe, expect, it } from "vitest";
import { createExecutor, grantApproval, type ExecutorDeps } from "../../contract/index.js";
import type { Ports } from "../../ports/index.js";
import { chatPolicy } from "../../testing/contract-helpers.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import { FakeRoutines, sampleRoutines } from "../../testing/routines-fakes.js";
import { createRoutinesCapability } from "./index.js";

const GROUPS = [{ owner: "owner-1", id: "g1", name: "Casa" }, { owner: "owner-1", id: "g2", name: "Trabalho" }, { owner: "owner-2", id: "gb", name: "Grupo do B" }];

function rig(opts: { ownerId?: string; readOnly?: boolean; policy?: ExecutorDeps["policy"] } = {}) {
	const routines = new FakeRoutines(sampleRoutines(), GROUPS.map((g) => ({ ...g })));
	const f = fakePorts();
	const capability = createRoutinesCapability({ routines, ...(opts.readOnly && { readOnly: true }) });
	const tool = (name: string) => {
		const found = capability.tools.find((t) => t.name === name);
		if (!found) throw new Error(`tool ${name} ausente`);
		return found;
	};
	const executor = createExecutor({ runId: "run-1", ownerId: opts.ownerId ?? "owner-1", ports: f.ports as unknown as Ports, hash: sha256, policy: opts.policy ?? chatPolicy });
	const run = (name: string, args: unknown) => executor.executeCall({ callId: "c1", step: 1, tool: tool(name), args });
	/** Chama e, se pedir o dono, aprova (como o cartão faz). */
	const approved = async (name: string, args: unknown) => {
		const pending = await run(name, args);
		if (pending.status !== "pending_approval") return pending;
		return executor.executeCall({ callId: "c1", step: 1, tool: tool(name), args, grant: grantApproval(pending.request, f.clock.now()) });
	};
	return { routines, capability, tool, executor, run, approved, f };
}

const summaryOf = (out: { status: string }) => (out.status === "ok" ? (out as unknown as { summary: string }).summary : JSON.stringify(out));

describe("capacidade routines: forma", () => {
	it("é lazy e com dono tem routine_list, routine_control e routine_group; sem dono (readOnly) só routine_list", () => {
		const cap = rig().capability;
		expect(cap.core).toBe(false);
		expect(cap.tools.map((t) => t.name)).toEqual(["routine_list", "routine_control", "routine_group"]);
		expect(rig({ readOnly: true }).capability.tools.map((t) => t.name)).toEqual(["routine_list"]);
		expect(rig({ readOnly: true }).capability.instructions).toContain("no owner present");
	});

	it("efeitos: lista é leitura privada; controle e grupo escrevem dentro do Atlas; apagar rotina é destrutivo", () => {
		const r = rig();
		expect(r.tool("routine_list")).toMatchObject({ effect: "read", privateData: true });
		expect(r.tool("routine_control").effectFor({ action: "pause", target: "x" })).toBe("write_internal");
		expect(r.tool("routine_control").effectFor({ action: "resume", target: "x" })).toBe("write_internal");
		expect(r.tool("routine_control").effectFor({ action: "delete", target: "x" })).toBe("destructive");
		expect(r.tool("routine_group").effect).toBe("write_internal");
	});

	it("o texto para o modelo explica quando usar e quando não usar, e não promete criar nem editar rotina", () => {
		const r = rig();
		expect(r.tool("routine_list").description).toMatch(/Not for reminders/);
		expect(r.tool("routine_control").description).toMatch(/Not for/);
		expect(r.tool("routine_group").description).toMatch(/Not for/);
		expect(r.capability.instructions).toContain("not available here yet");
	});
});

describe("routine_list", () => {
	it("lista só as rotinas do dono do run, com gatilho em frase, estado, grupo, alerta e próxima execução", async () => {
		const out = await rig().run("routine_list", {});
		const text = summaryOf(out);
		expect(out.status).toBe("ok");
		expect(text).toContain('"Resumo da manhã" [id r1] · todo dia às 8h · active');
		expect(text).toContain("last run 2026-11-08T11:00:00.000Z (succeeded)");
		expect(text).toContain('"Alerta do estoque"');
		expect(text).toContain("Alerta · confere a cada 2 horas");
		expect(text).toContain("next run 2026-11-09T16:00:00.000Z");
		expect(text).toContain('"Lembrar do aluguel" [id r3] · Uma vez · 03/12 às 10:00 · paused · group "Casa"');
		expect(text).toContain("does: Confere o estoque.");
		expect(text).not.toContain("secreta do B");
	});

	it("dono B só vê as dele (nunca as de A)", async () => {
		const text = summaryOf(await rig({ ownerId: "owner-2" }).run("routine_list", {}));
		expect(text).toContain("Rotina secreta do B");
		expect(text).not.toContain("Resumo da manhã");
		expect(text).not.toContain("Alerta do estoque");
	});

	it("filtros: só ativas e só alertas; lista vazia diz isso", async () => {
		const r = rig();
		const active = summaryOf(await r.run("routine_list", { onlyActive: true }));
		expect(active).toContain("Resumo da manhã");
		expect(active).not.toContain("Lembrar do aluguel");
		const alerts = summaryOf(await r.run("routine_list", { onlyAlerts: true }));
		expect(alerts).toContain("Alerta do estoque");
		expect(alerts).not.toContain("Resumo da manhã");
		expect(summaryOf(await rig({ ownerId: "ninguem" }).run("routine_list", {}))).toBe("No routines in this bot.");
		expect(summaryOf(await rig({ ownerId: "owner-2" }).run("routine_list", { onlyAlerts: true }))).toBe("No alerts in this bot.");
	});

	it("campo desconhecido falha com a lista do aceito", async () => {
		const out = await rig().run("routine_list", { group: "Casa" });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain("Accepted fields: onlyActive, onlyAlerts");
	});

	it("com mais de 25, mostra 25 e diz quantas faltam", async () => {
		const r = rig();
		for (let i = 0; i < 30; i++) r.routines.rows.push({ owner: "owner-1", id: `x${i}`, name: `Extra ${i}`, trigger: "A cada 2 h", kind: "interval", enabled: true, task: "t" });
		const text = summaryOf(await r.run("routine_list", {}));
		expect(text).toContain("Routines (25 of 33)");
		expect(text).toContain("(8 more not shown.)");
	});

	it("sem dono (readOnly) a lista segue funcionando", async () => {
		const r = rig({ readOnly: true, policy: { surface: "routine", ownerPresent: false, autonomy: "balanced", rules: [] } });
		expect((await r.run("routine_list", {})).status).toBe("ok");
	});
});

describe("routine_control", () => {
	it("pausar e retomar mudam o estado, dizem o que fizeram e deixam recibo; repetir não muda nada", async () => {
		const r = rig();
		const paused = await r.run("routine_control", { action: "pause", target: "Resumo da manhã" });
		expect(summaryOf(paused)).toBe('Routine "Resumo da manhã" paused.');
		expect(r.routines.rows.find((x) => x.id === "r1")?.enabled).toBe(false);
		const again = await r.run("routine_control", { action: "pause", target: "r1" });
		expect(summaryOf(again)).toContain("already paused. Nothing changed");
		expect(r.routines.calls.filter((c) => c.method === "setEnabled")).toHaveLength(1);
		const resumed = await r.run("routine_control", { action: "resume", target: "resumo" });
		expect(summaryOf(resumed)).toBe('Routine "Resumo da manhã" resumed.');
		expect(r.routines.rows.find((x) => x.id === "r1")?.enabled).toBe(true);
		expect(r.f.receipts.items.length).toBe(3);
	});

	it("alerta é chamado de alerta", async () => {
		expect(summaryOf(await rig().run("routine_control", { action: "pause", target: "estoque" }))).toBe('Alert "Alerta do estoque" paused.');
	});

	it("apagar pede o dono (cartão, mesmo em autonomia total) e o cartão diz QUAL rotina; nada some antes da aprovação", async () => {
		const r = rig({ policy: { ...chatPolicy, autonomy: "autonomous" } });
		const pending = await r.run("routine_control", { action: "delete", target: "aluguel" });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		expect(pending.request.effect).toBe("destructive");
		expect(pending.request.riskFacts).toMatchObject({ irreversible: true, target: "Lembrar do aluguel (Uma vez · 03/12 às 10:00)" });
		expect(r.routines.rows.some((x) => x.id === "r3")).toBe(true);
		const done = await r.approved("routine_control", { action: "delete", target: "aluguel" });
		expect(summaryOf(done)).toBe('Routine "Lembrar do aluguel" deleted for good.');
		expect(r.routines.rows.some((x) => x.id === "r3")).toBe(false);
	});

	it("pausar e retomar não pedem cartão em autonomia normal (voltam com outra chamada)", async () => {
		const out = await rig().run("routine_control", { action: "pause", target: "r1" });
		expect(out.status).toBe("ok");
	});

	it("sem dono presente, apagar fica fora (não executa nem pede)", async () => {
		const r = rig({ policy: { surface: "routine", ownerPresent: false, autonomy: "balanced", rules: [] } });
		const out = await r.run("routine_control", { action: "delete", target: "r1" });
		expect(out.status).toBe("not_available");
		expect(r.routines.rows.some((x) => x.id === "r1")).toBe(true);
	});

	it("não achou: erro com a dica; vários: pede para escolher e lista só nome e id", async () => {
		const r = rig();
		r.routines.rows.push({ owner: "owner-1", id: "r4", name: "Resumo da tarde", trigger: "todo dia às 18h", kind: "cron", enabled: true, task: "t" });
		const none = await r.run("routine_control", { action: "pause", target: "nada disso" });
		expect(none.status).toBe("error");
		expect(JSON.stringify(none)).toContain("routine_list");
		const many = await r.run("routine_control", { action: "pause", target: "resumo" });
		expect(many.status).toBe("error");
		expect(JSON.stringify(many)).toContain('Resumo da manhã\\" (id r1)');
		expect(JSON.stringify(many)).toContain('Resumo da tarde\\" (id r4)');
		expect(r.routines.rows.every((x) => x.enabled || x.id === "r3")).toBe(true);
	});

	it("dono B não pausa nem apaga a rotina de A (not found, nada muda), nem pelo id exato", async () => {
		const r = rig({ ownerId: "owner-2" });
		for (const action of ["pause", "resume", "delete"] as const) {
			for (const target of ["Resumo da manhã", "r1"]) {
				const out = await r.approved("routine_control", { action, target });
				expect(out.status, `${action} ${target}`).toBe("error");
				expect(JSON.stringify(out)).toContain("No routine matches");
			}
		}
		expect(r.routines.rows.find((x) => x.id === "r1")).toMatchObject({ owner: "owner-1", enabled: true });
		expect(r.routines.calls.filter((c) => c.method === "setEnabled" || c.method === "remove")).toEqual([]);
		// e todas as chamadas à porta levaram o dono do RUN
		expect(new Set(r.routines.calls.map((c) => c.userId))).toEqual(new Set(["owner-2"]));
	});

	it("ação inválida e campo desconhecido falham com o aceito; o dono vem só do run (não existe campo userId)", async () => {
		const r = rig();
		const bad = await r.run("routine_control", { action: "explode", target: "r1" });
		expect(bad.status).toBe("error");
		const extra = await r.run("routine_control", { action: "pause", target: "r1", userId: "owner-2" });
		expect(extra.status).toBe("error");
		expect(JSON.stringify(extra)).toContain("Accepted fields: action, target");
	});
});

describe("routine_group", () => {
	it("criar grupo; nome repetido falha com a mensagem real", async () => {
		const r = rig();
		const ok = await r.run("routine_group", { action: "create", group: "Finanças" });
		expect(summaryOf(ok)).toContain('Group "Finanças" created');
		const dup = await r.run("routine_group", { action: "create", group: "casa" });
		expect(dup.status).toBe("error");
		expect(JSON.stringify(dup)).toContain("Já existe um grupo com esse nome");
	});

	it("renomear por nome ou id e desfazer (as rotinas ficam)", async () => {
		const r = rig();
		const renamed = await r.run("routine_group", { action: "rename", group: "casa", newName: "Minha casa" });
		expect(summaryOf(renamed)).toContain('Group "Casa" renamed to "Minha casa"');
		const removed = await r.run("routine_group", { action: "delete", group: "g1" });
		expect(summaryOf(removed)).toContain("Its 1 routine stay, without a group");
		expect(r.routines.rows.find((x) => x.id === "r3")).toBeDefined();
		expect(r.routines.rows.find((x) => x.id === "r3")?.groupId).toBeUndefined();
	});

	it("pausar e retomar o grupo todo", async () => {
		const r = rig();
		r.routines.rows.find((x) => x.id === "r1")!.groupId = "g1";
		const paused = await r.run("routine_group", { action: "pause", group: "Casa" });
		expect(summaryOf(paused)).toContain('Group "Casa": 2 routines, 1 paused (the rest already were)');
		expect(r.routines.rows.filter((x) => x.groupId === "g1").every((x) => !x.enabled)).toBe(true);
		const resumed = await r.run("routine_group", { action: "resume", group: "Casa" });
		expect(summaryOf(resumed)).toContain("2 resumed");
	});

	it("mover rotina para um grupo existente e tirar do grupo", async () => {
		const r = rig();
		const moved = await r.run("routine_group", { action: "move", routine: "Resumo da manhã", group: "Trabalho" });
		expect(summaryOf(moved)).toBe('"Resumo da manhã" is now in the group "Trabalho".');
		expect(r.routines.rows.find((x) => x.id === "r1")?.groupId).toBe("g2");
		const out = await r.run("routine_group", { action: "ungroup", routine: "r1" });
		expect(summaryOf(out)).toBe('"Resumo da manhã" is out of its group.');
		expect(r.routines.rows.find((x) => x.id === "r1")?.groupId).toBeUndefined();
	});

	it("grupo que não existe: erro com os grupos que existem e a saída (criar); não cria sozinho", async () => {
		const r = rig();
		const out = await r.run("routine_group", { action: "move", routine: "r1", group: "Inexistente" });
		expect(out.status).toBe("error");
		expect(JSON.stringify(out)).toContain('Casa\\" (id g1)');
		expect(JSON.stringify(out)).toContain("action create");
		expect(r.routines.groupRows.some((g) => g.name === "Inexistente")).toBe(false);
	});

	it("falta de campo falha dizendo o que passar", async () => {
		const r = rig();
		for (const [args, needs] of [
			[{ action: "create" }, "group (the new group name)"],
			[{ action: "rename", group: "Casa" }, "newName"],
			[{ action: "move", routine: "r1" }, "routine (name or id) and group"],
			[{ action: "ungroup" }, "routine (name or id)"],
			[{ action: "pause" }, "group (name or id)"],
		] as const) {
			const out = await r.run("routine_group", args);
			expect(out.status, JSON.stringify(args)).toBe("error");
			expect(JSON.stringify(out)).toContain(needs);
		}
	});

	it("dono B não vê, renomeia, pausa, desfaz nem usa o grupo de A, e não move a rotina de A (not found)", async () => {
		const r = rig({ ownerId: "owner-2" });
		for (const args of [
			{ action: "rename", group: "Casa", newName: "Hackeado" },
			{ action: "rename", group: "g1", newName: "Hackeado" },
			{ action: "pause", group: "g1" },
			{ action: "delete", group: "g1" },
			{ action: "move", routine: "r1", group: "Grupo do B" },
			{ action: "move", routine: "rb1", group: "g1" },
			{ action: "ungroup", routine: "r3" },
		]) {
			const out = await r.run("routine_group", args);
			expect(out.status, JSON.stringify(args)).toBe("error");
		}
		expect(r.routines.groupRows.find((g) => g.id === "g1")?.name).toBe("Casa");
		expect(r.routines.rows.find((x) => x.id === "r3")?.groupId).toBe("g1");
		expect(r.routines.rows.find((x) => x.id === "r1")?.groupId).toBeUndefined();
		expect(r.routines.rows.find((x) => x.id === "rb1")?.groupId).toBeUndefined();
		const mutating = r.routines.calls.filter((c) => ["renameGroup", "deleteGroup", "setGroupEnabled", "moveToGroup"].includes(c.method));
		expect(mutating.every((c) => c.userId === "owner-2")).toBe(true);
		// A lista de grupos que o erro mostra não tem os do A
		const out = await r.run("routine_group", { action: "pause", group: "Casa" });
		expect(JSON.stringify(out)).toContain("Grupo do B");
		expect(JSON.stringify(out)).not.toContain("Trabalho");
	});

	it("sem dono presente a tool nem entra (readOnly)", () => {
		expect(rig({ readOnly: true }).capability.tools.map((t) => t.name)).not.toContain("routine_group");
	});
});
