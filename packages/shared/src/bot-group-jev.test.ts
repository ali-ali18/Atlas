import { describe, expect, it } from "vitest";
import {
	GROUP_JEV_TURN_MAX_REPLIES,
	buildGroupRolePrompt,
	buildJevRoutingQuestions,
	buildJevVerifyQuestions,
	buildRetryNudge,
	decideJevRoute,
	jevMemberKey,
	parseCoordinatorAssignments,
} from "./bot-group-jev.js";
import type { GroupMember } from "./bot-group.js";

const ana: GroupMember = { id: "ana", name: "Ana", description: "Coordena projetos", isPrimary: true };
const bia: GroupMember = { id: "bia", name: "Bia", description: "Financeiro" };
const caio: GroupMember = { id: "caio", name: "Caio", description: "Pesquisa" };
const members = [ana, bia, caio];

describe("perguntas do Jev para o grupo", () => {
	it("uma por membro, mais 'grupo todo' e 'tarefa de vários membros'", () => {
		const questions = buildJevRoutingQuestions(members);
		expect(Object.keys(questions)).toEqual([jevMemberKey("ana"), jevMemberKey("bia"), jevMemberKey("caio"), "group_wide", "multi_task"]);
		expect(questions[jevMemberKey("bia")]!.instructions).toContain("Bia (Financeiro)");
	});

	it("pergunta de verificação cita o membro e a subtarefa", () => {
		const q = buildJevVerifyQuestions({ name: "Bia", subtask: "levantar custos" });
		expect(q.fulfilled!.instructions).toBe("A resposta de Bia cumpre a subtarefa 'levantar custos'?");
	});
});

describe("decideJevRoute", () => {
	const answers = (over: Record<string, number>) => ({ [jevMemberKey("ana")]: 0.1, [jevMemberKey("bia")]: 0.1, [jevMemberKey("caio")]: 0.1, group_wide: 0.1, multi_task: 0.1, ...over });

	it("membros acima do limite respondem, do maior para o menor", () => {
		const d = decideJevRoute({ members, answers: answers({ [jevMemberKey("bia")]: 0.7, [jevMemberKey("caio")]: 0.9 }) });
		expect(d).toMatchObject({ mode: "members", ids: ["caio", "bia"] });
	});

	it("ninguém passou: o bot principal; sem principal, o melhor", () => {
		expect(decideJevRoute({ members, answers: answers({}) }).ids).toEqual(["ana"]);
		const noPrimary = members.map((m) => ({ ...m, isPrimary: false }));
		expect(decideJevRoute({ members: noPrimary, answers: answers({ [jevMemberKey("caio")]: 0.4 }) }).ids).toEqual(["caio"]);
	});

	it("grupo todo: todos os membros, no teto, principal primeiro", () => {
		const d = decideJevRoute({ members: [bia, ana, caio], answers: answers({ group_wide: 0.8 }) });
		expect(d.mode).toBe("group_wide");
		expect(d.ids).toEqual(["ana", "bia", "caio"]);
		const many = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
		expect(decideJevRoute({ members: many, answers: { group_wide: 1 } }).ids).toHaveLength(GROUP_JEV_TURN_MAX_REPLIES);
	});

	it("tarefa de vários membros: coordenador é o principal, senão o melhor", () => {
		expect(decideJevRoute({ members, answers: answers({ multi_task: 0.9 }) })).toMatchObject({ mode: "coordinate", ids: ["ana"] });
		const noPrimary = members.map((m) => ({ ...m, isPrimary: false }));
		expect(decideJevRoute({ members: noPrimary, answers: answers({ multi_task: 0.9, [jevMemberKey("bia")]: 0.5 }) })).toMatchObject({ mode: "coordinate", ids: ["bia"] });
	});
});

describe("parseCoordinatorAssignments", () => {
	it("uma subtarefa por membro citado; o coordenador não se atribui; código é ignorado", () => {
		const text = ["Plano:", "- @Bia levante os custos e entregue uma tabela", "- @Caio: pesquise concorrentes", "@Ana eu mesma resumo", "```", "@Bia ignorar", "```"].join("\n");
		expect(parseCoordinatorAssignments({ text, members, coordinatorId: "ana" })).toEqual([
			{ botId: "bia", subtask: "levante os custos e entregue uma tabela" },
			{ botId: "caio", subtask: "pesquise concorrentes" },
		]);
	});

	it("o mesmo membro em duas linhas junta as subtarefas; respeita o máximo", () => {
		const text = "@Bia faça A\n@Bia faça B\n@Caio faça C";
		const out = parseCoordinatorAssignments({ text, members, coordinatorId: "ana", max: 1 });
		expect(out).toEqual([{ botId: "bia", subtask: "faça A; faça B" }]);
	});
});

describe("prompts por papel", () => {
	it("coordenador manda dividir com @menções e não fazer a parte dos outros", () => {
		const p = buildGroupRolePrompt({ role: "coordinator", groupName: "Time", members, selfId: "ana" });
		expect(p).toContain("coordenador");
		expect(p).toContain("@Bia");
		expect(p).not.toContain("@Ana");
		expect(p.toLowerCase()).not.toContain("atlas");
	});

	it("membro recebe a subtarefa; na retentativa vem o 'faltou:'", () => {
		const first = buildGroupRolePrompt({ role: "worker", groupName: "Time", members, selfId: "bia", coordinatorName: "Ana", subtask: "levantar custos" });
		expect(first).toContain("levantar custos");
		expect(first).not.toContain("faltou:");
		const retry = buildGroupRolePrompt({ role: "worker", groupName: "Time", members, selfId: "bia", subtask: "levantar custos", attempt: 2 });
		expect(retry).toContain(buildRetryNudge("levantar custos"));
	});

	it("resumo proíbe @menções", () => {
		const p = buildGroupRolePrompt({ role: "summary", groupName: "Time", members, selfId: "ana", workerNames: ["Bia", "Caio"] });
		expect(p).toContain("Bia, Caio");
		expect(p).toContain("Não use @menções");
	});
});
