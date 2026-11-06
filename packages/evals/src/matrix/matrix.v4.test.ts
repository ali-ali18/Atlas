import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ENGINE_ADAPTERS } from "./engines.js";
import { runMatrix } from "./run.js";
import { loadScenarios, type Scenario } from "../scenario.js";
import { strongMatcher } from "../verdict.js";

/** `matrix --engines v4 --simulate`: o kernel `runAgent` (preset full, como o worker) roda pelo pipeline do matrix, sem rede. */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));
let scenarios: Scenario[] = [];

beforeAll(async () => {
	const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
	scenarios = ["gold-economia-bom-dia", "arquivo-explicito-csv"].map((fragment) => all.find((s) => s.id.includes(fragment))!);
	expect(scenarios.every(Boolean)).toBe(true);
});

describe("matrix --engines v4 --simulate", () => {
	it("registra o adaptador v4 e marca o cenário com o motor v4", () => {
		const patched = ENGINE_ADAPTERS.v4!.patchScenario(scenarios[0]!);
		expect(patched.run.engine).toBe("v4");
	});

	it("roda 2 cenários pelo kernel: 'Bom dia' sem tools passa; o de arquivo sem carregar a capacidade não cria arquivo e termina", async () => {
		const result = await runMatrix({ scenarios, engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(result.runs).toHaveLength(2);
		expect(result.runs.every((run) => run.status === "done" && run.engine === "v4")).toBe(true);
		expect(result.runs.every((run) => run.error === undefined)).toBe(true);
		const bomDia = result.records.find((record) => record.scenarioId === scenarios[0]!.id)!;
		expect(bomDia.pass).toBe(true);
		expect(bomDia.trajectory.toolCalls).toHaveLength(0);
		expect(bomDia.trajectory.events.some((event) => event.type === "done")).toBe(true);
		const file = result.records.find((record) => record.scenarioId === scenarios[1]!.id)!;
		// No preset `full` a entrega de arquivo é uma capacidade lazy: sem `use_capability`, a tool ainda não existe para o roteiro
		// legado. O kernel recusa a chamada (nenhum arquivo é criado, nenhum recibo), o run segue e termina.
		expect(file.trajectory.toolResults.some((r) => r.name === "create_file" && r.ok)).toBe(false);
		expect(file.trajectory.events.some((event) => event.type === "receipt")).toBe(false);
		expect(file.trajectory.events.some((event) => event.type === "done")).toBe(true);
		expect(result.summary.cells[scenarios[0]!.id]!.v4).toBeDefined();
	});

	it("carregando a capacidade de entregas antes (`use_capability`), create_file grava pelas entregas falsas e emite o recibo", async () => {
		const original = scenarios[1]!;
		const turns = [{ calls: [{ name: "use_capability", args: { id: "deliverables" } }] }, ...original.mock!.turns];
		const v4Scenario: Scenario = { ...original, mock: { ...original.mock!, turns } };
		const result = await runMatrix({ scenarios: [v4Scenario], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		const record = result.records[0]!;
		expect(record.trajectory.toolResults.find((r) => r.name === "create_file")?.ok).toBe(true);
		expect(record.trajectory.events.some((event) => event.type === "receipt")).toBe(true);
	});

	it("pesquisa: use_capability→research roda ajudantes reais que leem as páginas dos fixtures; o registro mostra a tool e as fontes", async () => {
		const original = (await loadScenarios(SCENARIOS_DIR, { recursive: true })).find((s) => s.id === "gold-pesquisa-fontes-divergentes")!;
		const blog = "https://blog.focoapp.test/2025-balanco";
		const report = "https://dadosabertos.test/relatorio-apps-2025";
		// O roteiro é uma fila só (mãe e ajudantes consomem na ordem das chamadas): mãe carrega e planeja; cada ajudante lê
		// uma página e responde; a mãe fecha. Dois ajudantes simétricos (ler, responder) não dependem de quem termina primeiro.
		const scenario: Scenario = {
			...original,
			mock: {
				turns: [
					{ calls: [{ name: "use_capability", args: { id: "research" } }] },
					{ calls: [{ name: "research", args: { questions: [{ question: "Quantos usuários ativos o FocoApp tinha, segundo o blog oficial?" }, { question: "Quantos usuários ativos o FocoApp tinha, segundo o relatório independente?" }], output_format: "answer" } }] },
					{ calls: [{ name: "web_extract", args: { url: blog } }] },
					{ calls: [{ name: "web_extract", args: { url: report } }] },
					{ say: "O blog diz 4,2 milhões de usuários ativos." },
					{ say: "O relatório diz 2,9 milhões de usuários ativos mensais." },
					{ say: "As fontes divergem: 4,2 milhões (blog) contra 2,9 milhões mensais (relatório)." },
				],
			},
		};
		const result = await runMatrix({ scenarios: [scenario], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(result.runs[0]!.status).toBe("done");
		expect(result.runs[0]!.error).toBeUndefined();
		const record = result.records[0]!;
		expect(record.trajectory.toolCalls.map((call) => call.name)).toContain("research");
		const research = record.trajectory.toolResults.find((r) => r.name === "research");
		expect(research?.ok).toBe(true);
		// As fontes vêm das páginas LIDAS pelos ajudantes (a porta de busca do eval responde pelos fixtures do cenário).
		expect(research?.summary).toContain(blog);
		expect(research?.summary).toContain(report);
		expect(research?.summary).toContain("4,2 milhões");
		// Os ajudantes passam pelo mesmo modelo do run: as 7 chamadas do roteiro (2 da mãe antes, 4 dos filhos, 1 final) estão medidas.
		expect(record.trajectory.modelCalls.filter((call) => call.usage).length).toBeGreaterThanOrEqual(7);
		expect(record.trajectory.stop?.reason ?? "answered").toBe("answered");
	});

	it("agenda (F4): os 6 cenários de lembrete e vigia passam pelo kernel com a capacidade agenda e a agenda falsa, sem cartão", async () => {
		const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
		const agenda = all.filter((s) => /^(gold|generic)-agenda-/.test(s.id));
		expect(agenda.map((s) => s.id).sort()).toEqual([
			"generic-agenda-reminder-tomorrow-0730-toronto",
			"generic-agenda-two-reminders-tomorrow-10am-and-8pm-sydney",
			"generic-agenda-watch-price-drop-keyboard",
			"gold-agenda-avisa-quando-preco-cair",
			"gold-agenda-compra-concluida-vigia-entrega-sozinho",
			"gold-agenda-lembrete-boleto-amanha-10h",
		]);
		const result = await runMatrix({ scenarios: agenda, engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(result.runs.every((run) => run.status === "done" && run.error === undefined)).toBe(true);
		for (const record of result.records) {
			expect(record.pass, `${record.scenarioId}: ${JSON.stringify(record.checks?.filter((c: { pass: boolean }) => !c.pass))} ${JSON.stringify(record.trajectory.toolResults)}`).toBe(true);
			const created = record.trajectory.toolResults.filter((r) => r.name === "remind_me" || r.name === "watch");
			// "10h e 20h" cria DOIS lembretes (auditoria F4, C2); os demais, um.
			expect(created).toHaveLength(record.scenarioId.includes("two-reminders") ? 2 : 1);
			expect(created.every((r) => r.ok)).toBe(true);
			expect(record.trajectory.events.some((event) => event.type === "receipt")).toBe(true);
		}
		// A verificação confere o que o MOTOR resolveu (horário no fuso do dono), não o que o roteiro pediu: um roteiro com o
		// horário errado reprova (auditoria F4, T1).
		const boleto = agenda.find((s) => s.id === "gold-agenda-lembrete-boleto-amanha-10h")!;
		const wrongTurns = boleto.engineOverrides!.v4!.mock!.turns.map((turn) => ("calls" in turn ? { calls: turn.calls.map((c) => (c.name === "remind_me" ? { ...c, args: { ...c.args, when: "2026-11-06T15:00" } } : c)) } : turn));
		const wrong = await runMatrix({ scenarios: [{ ...boleto, engineOverrides: { v4: { ...boleto.engineOverrides!.v4!, mock: { turns: wrongTurns } } } }], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(wrong.records[0]!.pass).toBe(false);
		expect(wrong.records[0]!.checks?.filter((c: { pass: boolean }) => !c.pass).map((c: { name: string }) => c.name)).toContain("agendou-amanha-as-10h-no-fuso-do-dono");
		// Sem a override do v4 o roteiro do v2 chama schedule_followup, que no v4 não existe: o matrix mostra a falha em vez de fingir.
		const v2Script = await runMatrix({ scenarios: [{ ...agenda[0]!, engineOverrides: undefined }], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(v2Script.records[0]!.pass).toBe(false);
	});
});
