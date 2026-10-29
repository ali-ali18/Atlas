"use client";

import { applySubagentEvent, type DevCiCheck, type DevSessionEvent, type SubagentTaskView } from "@workspace/shared";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { Message } from "@/components/ui/templates/template-4/data";

import { setActiveWorkItems } from "./active-work";
import { contextSummaryCard, devSessionCard, devSessionCardId } from "./cards";
import { ingestContextCompacted, ingestContextUsage, ingestDevSessionEvent, ingestDevTiming, markRunLive, recordSubagentEvent } from "./store";

export type DevFixtureMode = "running" | "done" | "pr" | "approval" | "approval-write" | "secrets";

/** Só em desenvolvimento e com `?devSessionFixture=1` (`=done`: sessão concluída; `=pr`: pronta, com PR, checks e cartão de confirmação). */
export function devSessionFixtureMode(search: string, env: string | undefined = process.env.NODE_ENV): DevFixtureMode | null {
	if (env === "production") return null;
	const value = new URLSearchParams(search).get("devSessionFixture");
	if (value === "done") return "done";
	if (value === "pr") return "pr";
	if (value === "approval" || value === "approval-write" || value === "secrets") return value;
	return value === "1" || value === "running" ? "running" : null;
}

export const FIXTURE_SESSION_ID = "fixture-session";
export const FIXTURE_GROUP_ID = "fixture-group";

export const FIXTURE_PR = {
	number: 42,
	url: "https://github.com/ali-ali18/agent-bot/pull/42",
	state: "open" as const,
	title: "Tratar título vazio no Panel",
	base: "main",
	head: "feat/painel",
	headSha: "9f3c2ab",
};

export const FIXTURE_CHECKS: DevCiCheck[] = [
	{ name: "build", status: "completed", conclusion: "success", url: "https://github.com/ali-ali18/agent-bot/actions/runs/1/job/11", durationMs: 72_000, jobId: 11 },
	{ name: "typecheck", status: "completed", conclusion: "success", url: "https://github.com/ali-ali18/agent-bot/actions/runs/1/job/12", durationMs: 48_000, jobId: 12 },
	{ name: "test (node 22)", status: "completed", conclusion: "failure", url: "https://github.com/ali-ali18/agent-bot/actions/runs/1/job/13", durationMs: 151_000, jobId: 13 },
	{ name: "lint", status: "in_progress", conclusion: null, url: "https://github.com/ali-ali18/agent-bot/actions/runs/1/job/14", jobId: 14 },
	{ name: "e2e", status: "completed", conclusion: "skipped", url: "https://github.com/ali-ali18/agent-bot/actions/runs/1/job/15", jobId: 15 },
];

const DIFF_PANEL = [
	"--- a/apps/web/components/panel.tsx",
	"+++ b/apps/web/components/panel.tsx",
	"@@ -12,7 +12,9 @@ export function Panel({ title }: Props) {",
	"   const [open, setOpen] = useState(false);",
	"-  const label = title;",
	"+  const label = title.trim() || \"Sem título\";",
	"+  const count = items.length;",
	"   return (",
	"     <section aria-label={label}>",
	"-      <h2>{title}</h2>",
	"+      <h2>{label}</h2>",
	"     </section>",
].join("\n");

const DIFF_UTIL = [
	"--- a/apps/web/lib/format.ts",
	"+++ b/apps/web/lib/format.ts",
	"@@ -1,4 +1,8 @@",
	" export function formatCount(n: number) {",
	"-  return String(n);",
	"+  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;",
	"+  return String(n);",
	" }",
	"+",
	"+export const MAX_ITEMS = 200;",
].join("\n");

/** Sequência de eventos de uma sessão de código plausível (só para pré-visualização). */
export function devSessionFixtureEvents(now: number, mode: DevFixtureMode, sessionAgeMs = 252_000): DevSessionEvent[] {
	const sessionId = FIXTURE_SESSION_ID;
	const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
	const events: DevSessionEvent[] = [
		{ type: "dev_session_status", sessionId, status: "CREATING", tier: "small", repo: "ali-ali18/agent-bot", branch: "feat/painel" },
		{ type: "dev_setup_step", sessionId, step: "container", status: "done", durationMs: 4100 },
		{ type: "dev_setup_step", sessionId, step: "clone", status: "done", durationMs: 9300 },
		{ type: "dev_setup_step", sessionId, step: "install", status: "done", durationMs: 41800 },
		{ type: "dev_session_status", sessionId, status: "RUNNING", tier: "small", repo: "ali-ali18/agent-bot", branch: "feat/painel" },
		{
			type: "todo_updated",
			sessionId,
			items: [
				{ id: "1", content: "Ler o componente Panel e os testes existentes", status: "completed" },
				{ id: "2", content: "Tratar título vazio no Panel", status: "completed" },
				{ id: "3", content: "Rodar a suíte de testes e corrigir falhas", status: "in_progress" },
				{ id: "4", content: "Abrir o pull request", status: "pending" },
			],
		},
		{ type: "shell_started", sessionId, callId: "c1", jobId: "j1", cmd: "git status --short", cwd: "/workspace", startedAt: iso(-200_000) },
		{ type: "shell_output", sessionId, callId: "c1", jobId: "j1", chunk: " M apps/web/components/panel.tsx\n" },
		{ type: "shell_done", sessionId, callId: "c1", jobId: "j1", exitCode: 0, durationMs: 310, endedReason: "exit" },
		{ type: "file_edit", sessionId, callId: "e1", path: "apps/web/components/panel.tsx", diff: DIFF_PANEL, added: 3, removed: 2 },
		{ type: "file_edit", sessionId, callId: "e2", path: "apps/web/lib/format.ts", diff: DIFF_UTIL, added: 5, removed: 1 },
		{
			type: "shell_started",
			sessionId,
			callId: "c2",
			jobId: "j2",
			cmd: "pnpm --filter web exec tsc --noEmit",
			cwd: "/workspace",
			startedAt: iso(-120_000),
		},
		{
			type: "shell_output",
			sessionId,
			callId: "c2",
			jobId: "j2",
			chunk: "apps/web/lib/format.ts(7,3): \u001b[31merror\u001b[0m TS2322: Type 'string' is not assignable to type 'number'.\n",
		},
		{ type: "shell_done", sessionId, callId: "c2", jobId: "j2", exitCode: null, durationMs: 30000, endedReason: "background_running" },
		{ type: "shell_done", sessionId, callId: "c2", jobId: "j2", exitCode: 2, durationMs: 18400, endedReason: "exit" },
		{ type: "shell_started", sessionId, callId: "c3", jobId: "j3", cmd: "pnpm test", cwd: "/workspace", startedAt: iso(sessionAgeMs - 72_000) },
		{ type: "shell_done", sessionId, callId: "c3", jobId: "j3", exitCode: null, durationMs: 30000, endedReason: "background_running" },
		{
			type: "shell_output",
			sessionId,
			callId: "c3",
			jobId: "j3",
			chunk: "\u001b[1m RUN \u001b[22m v3.2.4 /workspace\n \u001b[32m✓\u001b[39m lib/format.test.ts (4 tests) 12ms\n \u001b[32m✓\u001b[39m components/panel.test.tsx (6 tests) 41ms\n",
		},
	];
	if (mode === "pr") {
		events.push(
			{ type: "shell_output", sessionId, callId: "c3", jobId: "j3", chunk: "\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n" },
			{ type: "shell_done", sessionId, callId: "c3", jobId: "j3", exitCode: 0, durationMs: 21700, endedReason: "exit" },
			{ type: "dev_pr", sessionId, ...FIXTURE_PR },
			{ type: "dev_ci", sessionId, checks: FIXTURE_CHECKS, summary: "failing" },
		);
	}
	if (mode === "done") {
		events.push(
			{ type: "shell_output", sessionId, callId: "c3", jobId: "j3", chunk: "\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n" },
			{ type: "shell_done", sessionId, callId: "c3", jobId: "j3", exitCode: 0, durationMs: 21700, endedReason: "exit" },
			{
				type: "todo_updated",
				sessionId,
				items: [
					{ id: "1", content: "Ler o componente Panel e os testes existentes", status: "completed" },
					{ id: "2", content: "Tratar título vazio no Panel", status: "completed" },
					{ id: "3", content: "Rodar a suíte de testes e corrigir falhas", status: "completed" },
					{ id: "4", content: "Abrir o pull request", status: "completed" },
				],
			},
			{ type: "dev_session_status", sessionId, status: "STOPPED", tier: "small", repo: "ali-ali18/agent-bot", branch: "feat/painel" },
		);
	}
	return events;
}

function fixtureSubagents(now: number): { message: Message; apply: () => void } {
	const events = [
		{ type: "subagent_started" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 0, goal: "Mapear onde o Panel é usado e quais testes cobrem o componente.", title: "Mapear usos do Panel", childRunId: "r1", model: "openai/gpt-5" },
		{ type: "subagent_started" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 1, goal: "Revisar a documentação de acessibilidade do projeto.", title: "Revisar acessibilidade", childRunId: "r2", model: "openai/gpt-5" },
		{ type: "subagent_tool" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 0, childRunId: "r1", name: "grep", ok: true },
		{ type: "subagent_tool" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 0, childRunId: "r1", name: "read_file", ok: true },
		{ type: "subagent_tool" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 1, childRunId: "r2", name: "web_search", ok: true },
		{ type: "subagent_done" as const, groupId: FIXTURE_GROUP_ID, taskIndex: 1, childRunId: "r2", status: "ok" as const, summary: "A página segue o guia WAI-ARIA: **landmarks** presentes e foco visível.", toolsUsed: ["web_search"] },
	];
	let tasks: SubagentTaskView[] = [];
	for (const event of events) tasks = applySubagentEvent(tasks, event);
	return {
		message: { id: `subagents-${FIXTURE_GROUP_ID}`, kind: "subagents", groupId: FIXTURE_GROUP_ID, tasks },
		apply: () => {
			events.forEach((event, index) => recordSubagentEvent(event, now - 95_000 + index * 4000));
		},
	};
}

/** Itens de "Em andamento" da pré-visualização: sessão trabalhando, aguardando aprovação, subagente e uma terminada. */
function fixtureActiveWork(now: number) {
	const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
	return [
		{ kind: "dev" as const, id: FIXTURE_SESSION_ID, conversationId: "c1", conversationTitle: "Bia", botId: "fixture-bot", status: "RUNNING" as const, repo: "ali-ali18/agent-bot", branch: "feat/painel", startedAt: iso(-252_000), lastActiveAt: iso(-1000), awaitingApproval: false },
		{ kind: "dev" as const, id: "fixture-2", conversationId: "c2", conversationTitle: "Revisor", botId: "fixture-bot-2", status: "RUNNING" as const, repo: "ali-ali18/site", branch: "fix/login", startedAt: iso(-95_000), lastActiveAt: iso(-2000), awaitingApproval: true },
		{ kind: "subagent" as const, id: "fixture-sub", conversationId: "c3", conversationTitle: "Pesquisa", botId: "fixture-bot-3", title: "Mapear usos do Panel", startedAt: iso(-40_000), awaitingApproval: false },
		{ kind: "dev" as const, id: "fixture-3", conversationId: "c4", conversationTitle: "Docs", botId: "fixture-bot-4", status: "STOPPED" as const, repo: "ali-ali18/docs", branch: "main", startedAt: iso(-900_000), lastActiveAt: iso(-60_000), awaitingApproval: false },
	];
}

/** Injeta a sessão de exemplo no store e no fim da conversa (apenas fora de produção). */
export function useDevSessionFixture(
	enabled: boolean,
	setMessages: Dispatch<SetStateAction<Message[]>>,
	conversationId?: string,
) {
	useEffect(() => {
		if (!enabled || typeof window === "undefined") return;
		const mode = devSessionFixtureMode(window.location.search);
		if (!mode) return;
		const now = Date.now();
		// A sessão "começou" há 4m12s para o cronômetro já nascer com valor realista.
		const sessionAge = 252_000;
		if (mode === "running") markRunLive("fixture");
		const approval = mode === "approval" || mode === "approval-write";
		const secretsCard: Message | null =
			mode === "secrets"
				? {
						id: "fixture-secrets",
						kind: "confirm",
						title: "Este projeto precisa de: DATABASE_URL, STRIPE_KEY",
						description: "Os testes de integração abrem o banco e criam uma sessão de pagamento de teste.",
						status: "pending",
						confirmLabel: "Salvar",
						cancelLabel: "Agora não",
						confirmId: "confirm-fixture-secrets",
						secretsRequest: { environmentId: "fixture-env", repo: "ali-ali18/agent-bot", names: ["DATABASE_URL", "STRIPE_KEY"], reason: "Os testes de integração abrem o banco e criam uma sessão de pagamento de teste." },
					}
				: null;
		const confirm: Message | null = approval
			? {
					id: "fixture-pr-confirm",
					kind: "confirm",
					title: mode === "approval" ? "Executar este comando?" : "Aplicar esta alteração?",
					status: "pending",
					confirmLabel: mode === "approval" ? "Executar" : "Aplicar",
					cancelLabel: "Agora não",
					confirmId: "confirm-fixture",
					devApproval:
						mode === "approval"
							? { kind: "command", command: "pnpm exec playwright test --project=chromium && docker compose up -d --build", cwd: "/workspace/agent-bot", repo: "ali-ali18/agent-bot", branch: "feat/painel", reason: "Este comando não está na lista liberada.", prefixes: ["pnpm exec playwright", "docker compose"] }
							: { kind: "write", path: "src/components/panel.tsx", preview: "-const title = props.title;\n+const title = props.title?.trim() || \"Sem título\";\n return <h2>{title}</h2>;", added: 2, removed: 1, repo: "ali-ali18/agent-bot", branch: "feat/painel" },
				}
			: mode === "pr"
				? {
						id: "fixture-pr-confirm",
						kind: "confirm",
						title: "Criar pull request?",
						description: "Tratar título vazio no Panel\nmain ← feat/painel\n2 arquivos alterados · 3 commits",
						status: "pending",
						confirmLabel: "Criar PR",
						cancelLabel: "Agora não",
						confirmId: "confirm-fixture",
					}
				: null;
		devSessionFixtureEvents(now - sessionAge, approval || mode === "secrets" ? "done" : mode, sessionAge).forEach((event, index) => {
			ingestDevSessionEvent(event, { at: now - sessionAge + index * 500, seq: index + 1, runId: "fixture" });
		});
		ingestDevSessionEvent({ type: "dev_environment_updated", sessionId: FIXTURE_SESSION_ID, repo: "ali-ali18/agent-bot", auto: true, applied: ["installCommand", "tier"], note: "Ambiente detectado automaticamente" }, { at: now - sessionAge + 400, seq: 90, runId: "fixture" });
		ingestDevSessionEvent({ type: "dev_environment_updated", sessionId: FIXTURE_SESSION_ID, repo: "ali-ali18/agent-bot", applied: ["tier"], note: "Recursos aumentados para Médio" }, { at: now - 30_000, seq: 91, runId: "fixture" });
		const subagents = fixtureSubagents(now);
		subagents.apply();
		ingestContextCompacted({ sessionId: FIXTURE_SESSION_ID, before: 118_000, after: 42_000 }, { at: now - 60_000, seq: 500, runId: "fixture" });
		ingestContextUsage({ sessionId: FIXTURE_SESSION_ID, model: "anthropic/claude-sonnet-5.5", usedTokens: 54_000, windowTokens: 128_000, compactAtTokens: 102_400 }, { at: now - 30_000, seq: 501, runId: "fixture" });
		// Dois runs: o primeiro parou num cartão de aprovação (3 min até o segundo começar).
		const base = { sessionId: FIXTURE_SESSION_ID, model: "anthropic/claude-sonnet-5.5", approvalMs: 0 };
		ingestDevTiming({ type: "dev_timing", ...base, startedAt: now - 600_000, modelMs: 80_000, firstTokenMs: 9_600, toolsMs: 36_000, shellMs: 30_000, pollWaitMs: 5_000, setupMs: 40_000, steps: 8, approvalPendingAt: now - 420_000 }, { at: now - 420_000, seq: 600, runId: "fixture-a" });
		ingestDevTiming({ type: "dev_timing", ...base, startedAt: now - 240_000, modelMs: 50_000, firstTokenMs: 12_000, toolsMs: 31_000, shellMs: 25_000, pollWaitMs: 5_000, setupMs: 0, steps: 10 }, { at: now - 20_000, seq: 601, runId: "fixture-b" });
		const divider = contextSummaryCard("fixture:500", 118_000, 42_000);
		// Sequência do chat: pedido, texto do agente, depois o cartão da sessão no fim do turno.
		const sequence: Message[] = [
			{ id: "fixture-user", kind: "user", text: "Rode os testes do projeto e corrija o que falhar.", createdAt: new Date(now - sessionAge - 5_000).toISOString() },
			{ id: "fixture-assistant", kind: "assistant", text: "Vou abrir uma sessão no repositório, ler o componente Panel e rodar a suíte de testes.", createdAt: new Date(now - sessionAge).toISOString() },
		];
		setMessages((previous) => {
			previous = [...previous, ...sequence.filter((item) => !previous.some((m) => m.id === item.id))];
			const next = previous.filter((m) => m.id !== devSessionCardId(FIXTURE_SESSION_ID) && m.id !== subagents.message.id && m.id !== divider.id);
			return [...next.filter((m) => m.id !== "fixture-pr-confirm" && m.id !== "fixture-secrets"), devSessionCard(FIXTURE_SESSION_ID), divider, subagents.message, ...(confirm ? [confirm] : []), ...(secretsCard ? [secretsCard] : [])];
		});
		setActiveWorkItems(fixtureActiveWork(now), { freeze: true });
		if (mode !== "running") return;
		// Saída viva: um teste novo a cada 2 s no comando em execução.
		let n = 0;
		const timer = setInterval(() => {
			n += 1;
			if (n > 60) return clearInterval(timer);
			ingestDevSessionEvent(
				{ type: "shell_output", sessionId: FIXTURE_SESSION_ID, callId: "c3", jobId: "j3", chunk: ` \u001b[32m✓\u001b[39m suites/caso-${n}.test.ts (3 tests) ${10 + n}ms\n` },
				{ at: Date.now(), seq: 1000 + n, runId: "fixture" },
			);
		}, 2000);
		return () => clearInterval(timer);
	}, [enabled, setMessages, conversationId]);
}

/** Pré-visualização (`?devSessionFixture=1`): mostra a linha ao vivo como se o agente estivesse trabalhando. */
export function useDevFixtureWorking(): boolean {
	const [working, setWorking] = useState(false);
	useEffect(() => {
		setWorking(typeof window !== "undefined" && ["running", "approval"].includes(devSessionFixtureMode(window.location.search) ?? ""));
	}, []);
	return working;
}
