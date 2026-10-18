import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFixtureServer } from "./fixtures/lms/server.mjs";
import { createDryManager, lostScript, oracleScript, scriptedStreamChat } from "./dry.js";
import { renderJson, renderMarkdown } from "./report.js";
import { runTask, screenshotDataUrl } from "./runner.js";
import { TASKS } from "./tasks.js";
import type { RunMetrics } from "./metrics.js";
import type { Truth } from "./types.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let truth: Truth;

beforeAll(async () => {
	fixture = await startFixtureServer({ host: "127.0.0.1" });
	truth = (await (await fetch(`${fixture.url}/__truth`)).json()) as Truth;
});
afterAll(async () => {
	await fixture.close();
});

async function dryRun(taskId: string, behavior: "oracle" | "lost") {
	const task = TASKS.find((candidate) => candidate.id === taskId)!;
	const script = behavior === "oracle" ? oracleScript(task, truth, fixture.url) : lostScript();
	return runTask({
		task,
		model: "dry/scripted",
		rep: 1,
		fixture: { base: fixture.url, control: fixture.url },
		manager: createDryManager(),
		getSessionId: async () => "dry-session",
		apiKey: "dry",
		streamChat: scriptedStreamChat(script),
		maxSteps: 12,
	});
}

describe("harness offline - runtime real + LLM roteirizado + fixture", () => {
	it.each(TASKS.map((task) => task.id))("%s: o agente perfeito passa no checker", async (taskId) => {
		const { metrics, artifacts } = await dryRun(taskId, "oracle");
		expect(metrics.details, JSON.stringify({ outcome: metrics.outcome, error: metrics.error, answer: artifacts.answer })).toEqual(["all expected items found"]);
		expect(metrics.success).toBe(true);
		expect(metrics.score).toBe(1);
		expect(metrics.decisions).toBeGreaterThanOrEqual(2);
		expect(metrics.promptTokens).toBeGreaterThan(0);
		expect(metrics.costUsd).toBeGreaterThan(0);
	}, 30_000);

	it.each(TASKS.map((task) => task.id))("%s: um agente perdido falha no checker", async (taskId) => {
		const { metrics } = await dryRun(taskId, "lost");
		expect(metrics.success).toBe(false);
		expect(metrics.score).toBeLessThan(1);
	}, 30_000);

	it("coleta métricas de navigate, T6 passa pelo card de login e T10 conta o screenshot", async () => {
		const t6 = await dryRun("T6", "oracle");
		expect(t6.metrics.loginRequested).toBe(true);
		expect(t6.metrics.outcome).toBe("completed");
		const t10 = await dryRun("T10", "oracle");
		expect(t10.metrics.screenshots).toBe(1);
		expect(t10.metrics.navigate.count).toBe(1);
		expect(t10.metrics.navigate.avgGotoMs).toBe(12);
		expect(t10.metrics.navigate.avgReadyMs).toBe(40);
	}, 30_000);

	it("o run com screenshot reenvia a imagem ao modelo como data URL (o provider rejeita base64 puro)", async () => {
		const task = TASKS.find((candidate) => candidate.id === "T10")!;
		const inner = scriptedStreamChat(oracleScript(task, truth, fixture.url));
		const imageUrls: string[] = [];
		await runTask({
			task,
			model: "dry/scripted",
			rep: 1,
			fixture: { base: fixture.url, control: fixture.url },
			manager: createDryManager(),
			getSessionId: async () => "dry-session",
			apiKey: "dry",
			maxSteps: 12,
			streamChat: async (params) => {
				for (const message of params.messages) {
					if (!Array.isArray(message.content)) continue;
					for (const part of message.content) if (part.type === "image_url") imageUrls.push(part.image_url.url);
				}
				return inner();
			},
		});
		expect(imageUrls.length).toBeGreaterThan(0);
		for (const url of imageUrls) expect(url.startsWith("data:image/png;base64,") || url.startsWith("data:image/jpeg;base64,")).toBe(true);
	}, 30_000);

	it("screenshotDataUrl escolhe o mime pelo conteúdo", () => {
		expect(screenshotDataUrl("iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(screenshotDataUrl("/9j/4AAQ")).toBe("data:image/jpeg;base64,/9j/4AAQ");
	});

	it("T3 guarda o conteúdo do create_file (sem db) e T8 lê a URL final da aba", async () => {
		const t3 = await dryRun("T3", "oracle");
		expect(t3.artifacts.files[0]?.filename).toBe("databases.pdf");
		expect(t3.artifacts.files[0]?.content).toContain("Week 9: Distributed storage");
		const t8 = await dryRun("T8", "oracle");
		expect(t8.artifacts.finalUrl).toBe(`${fixture.url}/course/c103/about`);
	}, 30_000);

	it("o relatório junta os runs em tabela markdown e JSON", async () => {
		const runs: RunMetrics[] = [];
		for (const id of ["T1", "T2"]) runs.push((await dryRun(id, "oracle")).metrics);
		runs.push((await dryRun("T1", "lost")).metrics);
		const markdown = renderMarkdown(runs, { startedAt: "2026-10-12" });
		expect(markdown).toContain("| dry/scripted | T1 | 1/2 |");
		expect(markdown).toContain("| dry/scripted | T2 | 1/1 |");
		expect(markdown).toContain("## Falhas");
		const json = JSON.parse(renderJson(runs));
		expect(json.runs).toHaveLength(3);
		expect(json.summary).toHaveLength(2);
	}, 30_000);
});
