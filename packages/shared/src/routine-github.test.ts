import { describe, expect, it } from "vitest";
import {
	GITHUB_CI_EVENTS,
	GITHUB_PR_BABYSIT_EVENTS,
	GITHUB_ROUTINE_TEMPLATES,
	GITHUB_TRIGGER_EVENTS,
	buildGithubRoutinePromptDetail,
	describeGithubTrigger,
	describeGithubTriggerClauses,
	githubEventMatchesTrigger,
	githubTriggerInputSchema,
	githubWebhookEventsFor,
	isGithubTriggerEvent,
	isGithubWebhookTrigger,
	normalizeGithubEvents,
	normalizeGithubRepo,
	normalizeGithubUsers,
	normalizeGithubWebhook,
	parseGithubTriggerInput,
	parseGithubWebhookTrigger,
} from "./routine-github.js";

describe("normalizeGithubRepo", () => {
	it("aceita owner/repo simples", () => {
		expect(normalizeGithubRepo("acme/site")).toBe("acme/site");
	});
	it("aceita colar a URL do GitHub", () => {
		expect(normalizeGithubRepo("https://github.com/acme/site.git")).toBe("acme/site");
		expect(normalizeGithubRepo("https://github.com/acme/site/")).toBe("acme/site");
	});
	it("rejeita formatos inválidos", () => {
		expect(normalizeGithubRepo("acme")).toBeNull();
		expect(normalizeGithubRepo("acme/site/extra")).toBeNull();
		expect(normalizeGithubRepo("")).toBeNull();
		expect(normalizeGithubRepo(123)).toBeNull();
	});
});

describe("normalizeGithubEvents / normalizeGithubUsers", () => {
	it("dedup e ordena pela ordem canônica", () => {
		expect(normalizeGithubEvents(["pr_merged", "pr_opened", "pr_opened"])).toEqual([
			"pr_opened",
			"pr_merged",
		]);
		expect(normalizeGithubEvents(["ci_failed", "pr_opened"])).toEqual(["pr_opened", "ci_failed"]);
		expect(normalizeGithubEvents(["pr_opened", "push"])).toEqual(["push", "pr_opened"]);
	});
	it("rejeita evento desconhecido/removido (v1 e v2 antigos) ou lista vazia", () => {
		expect(normalizeGithubEvents(["pr_opened", "deploy"])).toBeNull();
		expect(normalizeGithubEvents(["pull_request"])).toBeNull();
		expect(normalizeGithubEvents(["release"])).toBeNull();
		expect(normalizeGithubEvents(["issue_opened"])).toBeNull();
		expect(normalizeGithubEvents(["issue_commented"])).toBeNull();
		expect(normalizeGithubEvents([])).toBeNull();
		expect(normalizeGithubEvents("push")).toBeNull();
	});
	it("users: trim, tira @, dedup case-insensitive, vazio vira undefined", () => {
		expect(normalizeGithubUsers([" ana", "@Ana", "bot "])).toEqual(["ana", "bot"]);
		expect(normalizeGithubUsers([])).toBeUndefined();
		expect(normalizeGithubUsers(undefined)).toBeUndefined();
	});
});

describe("githubTriggerInputSchema / parseGithubTriggerInput", () => {
	it("aceita config válida", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["pr_opened", "issue_assigned"],
			users: ["ana"],
		});
		expect("value" in result).toBe(true);
		if ("value" in result) {
			expect(result.value.repo).toBe("acme/site");
			expect(result.value.events).toEqual(["pr_opened", "issue_assigned"]);
			expect(result.value.users).toEqual(["ana"]);
			expect(result.value.prNumber).toBeUndefined();
			expect(result.value.ciBranch).toBeUndefined();
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("aceita colar a URL do GitHub como repo e normaliza", () => {
		const result = parseGithubTriggerInput({
			repo: "https://github.com/acme/site.git",
			events: ["pr_opened"],
		});
		if ("value" in result) {
			expect(result.value.repo).toBe("acme/site");
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("users com @ e duplicado: tira @ e dedup", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["pr_opened"],
			users: ["@Ana", "ana", "@bot"],
		});
		if ("value" in result) {
			expect(result.value.users).toEqual(["Ana", "bot"]);
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("aceita prNumber (babá de PR)", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["pr_commented"],
			prNumber: 42,
		});
		if ("value" in result) {
			expect(result.value.prNumber).toBe(42);
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("rejeita prNumber inválido", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["pr_opened"],
			prNumber: -1,
		});
		expect("error" in result).toBe(true);
	});
	it("ci_* exige branch quando não há prNumber", () => {
		const semNada = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["ci_failed"],
		});
		expect("error" in semNada).toBe(true);

		const comBranch = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["ci_failed"],
			branch: "main",
		});
		if ("value" in comBranch) {
			expect(comBranch.value.branch).toBe("main");
		} else {
			throw new Error("esperava sucesso");
		}

		const comPrNumber = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["ci_passed"],
			prNumber: 7,
		});
		expect("value" in comPrNumber).toBe(true);
	});
	it("aceita ciBranch como alias legado de branch", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["ci_failed"],
			ciBranch: "main",
		});
		if ("value" in result) {
			expect(result.value.branch).toBe("main");
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("branch (novo campo) tem precedência sobre ciBranch (legado) quando ambos vêm", () => {
		const result = parseGithubTriggerInput({
			repo: "acme/site",
			events: ["ci_failed"],
			branch: "main",
			ciBranch: "outra",
		});
		if ("value" in result) {
			expect(result.value.branch).toBe("main");
		} else {
			throw new Error("esperava sucesso");
		}
	});
	it("rejeita repo/eventos inválidos", () => {
		expect("error" in parseGithubTriggerInput({ repo: "bad", events: ["pr_opened"] })).toBe(true);
		expect("error" in parseGithubTriggerInput({ repo: "acme/site", events: [] })).toBe(true);
		expect("error" in parseGithubTriggerInput(null)).toBe(true);
	});
	it("schema exportado é o mesmo usado por parseGithubTriggerInput", () => {
		const parsed = githubTriggerInputSchema.safeParse({
			repo: "acme/site",
			events: ["pr_opened"],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("isGithubWebhookTrigger / parseGithubWebhookTrigger (v3)", () => {
	const base = {
		kind: "github",
		repo: "acme/site",
		events: ["pr_opened"],
	};
	it("valida shape mínimo (só kind/repo/events)", () => {
		expect(isGithubWebhookTrigger(base)).toBe(true);
		expect(isGithubWebhookTrigger({ ...base, repo: "" })).toBe(false);
		expect(isGithubWebhookTrigger({ ...base, events: "nope" })).toBe(false);
		expect(isGithubWebhookTrigger(null)).toBe(false);
	});
	it("parseia e preenche defaults", () => {
		const parsed = parseGithubWebhookTrigger(base);
		expect(parsed?.events).toEqual(["pr_opened"]);
		expect(parsed?.prNumber).toBeUndefined();
		expect(parsed?.users).toBeUndefined();
	});
	it("preserva prNumber/users/branch/state", () => {
		const parsed = parseGithubWebhookTrigger({
			...base,
			events: ["ci_failed"],
			branch: "main",
			users: ["ana"],
			prNumber: 9,
			state: { lastWebhookAt: "2026-01-01T00:00:00.000Z" },
		});
		expect(parsed?.branch).toBe("main");
		expect(parsed?.users).toEqual(["ana"]);
		expect(parsed?.prNumber).toBe(9);
		expect(parsed?.state?.lastWebhookAt).toBe("2026-01-01T00:00:00.000Z");
	});
	it("lê ciBranch legado (linha persistida antes da generalização) como branch", () => {
		const parsed = parseGithubWebhookTrigger({
			...base,
			events: ["ci_failed"],
			ciBranch: "main",
		});
		expect(parsed?.branch).toBe("main");
	});
	it("tolera ler linhas já persistidas do v2 com campos mortos (hookKey/secretEnc/delivery/pollIntervalMinutes/webhookId)", () => {
		const parsed = parseGithubWebhookTrigger({
			kind: "github",
			hookKey: "abc",
			repo: "acme/site",
			events: ["pr_opened", "pr_merged"],
			delivery: "webhook",
			pollIntervalMinutes: 5,
			secretEnc: "v1:iv:tag:ct",
			webhookId: 123,
			state: {
				lastWebhookAt: "2026-01-01T00:00:00.000Z",
				lastEventId: "999",
				etag: "W/abc",
				lastPolledAt: "2026-01-01T00:00:00.000Z",
				lastCiSha: "deadbeef",
				lastCiConclusion: "success",
			},
		});
		expect(parsed?.events).toEqual(["pr_opened", "pr_merged"]);
		expect((parsed as unknown as { hookKey?: string }).hookKey).toBeUndefined();
		expect((parsed as unknown as { secretEnc?: string }).secretEnc).toBeUndefined();
		expect((parsed as unknown as { delivery?: string }).delivery).toBeUndefined();
		expect((parsed as unknown as { pollIntervalMinutes?: number }).pollIntervalMinutes).toBeUndefined();
		expect((parsed as unknown as { webhookId?: number }).webhookId).toBeUndefined();
		expect(parsed?.state).toEqual({ lastWebhookAt: "2026-01-01T00:00:00.000Z" });
	});
	it("descarta silenciosamente eventos removidos (release/issue_opened/issue_commented) de linhas antigas, mas preserva push (voltou ao vocabulário)", () => {
		const parsed = parseGithubWebhookTrigger({
			kind: "github",
			repo: "acme/site",
			events: ["pr_opened", "push", "release", "issue_opened", "issue_commented"],
			delivery: "poll",
		});
		expect(parsed?.events).toEqual(["push", "pr_opened"]);
	});
});

describe("compat v1 → v3", () => {
	it("migra pull_request pra pr_opened/pr_pushed/pr_merged/pr_closed", () => {
		const v1 = {
			kind: "github",
			hookKey: "abc",
			repo: "acme/site",
			events: ["pull_request"],
			mode: "webhook",
			pollIntervalMinutes: 5,
			secretEnc: "v1:iv:tag:ct",
			tokenEnc: "should-be-ignored",
		};
		expect(isGithubWebhookTrigger(v1)).toBe(true);
		const parsed = parseGithubWebhookTrigger(v1);
		expect(parsed?.events).toEqual(
			expect.arrayContaining(["pr_opened", "pr_pushed", "pr_merged", "pr_closed"]),
		);
		expect(parsed?.events.length).toBe(4);
		expect((parsed as unknown as { tokenEnc?: string }).tokenEnc).toBeUndefined();
	});
	it("migra issues/push/release (v1) pra lista vazia sem lançar", () => {
		const migraIssues = parseGithubWebhookTrigger({
			kind: "github",
			hookKey: "abc",
			repo: "acme/site",
			events: ["issues"],
			mode: "poll",
			secretEnc: "v1:iv:tag:ct",
		});
		expect(migraIssues?.events).toEqual([]);

		const migraPushRelease = parseGithubWebhookTrigger({
			kind: "github",
			hookKey: "abc",
			repo: "acme/site",
			events: ["push", "release"],
			mode: "both",
			secretEnc: "v1:iv:tag:ct",
		});
		expect(migraPushRelease?.events).toEqual([]);
	});
	it("ignora branches do v1 (sem equivalente em v3)", () => {
		const parsed = parseGithubWebhookTrigger({
			kind: "github",
			hookKey: "abc",
			repo: "acme/site",
			events: ["pull_request"],
			mode: "poll",
			branches: ["main"],
			secretEnc: "v1:iv:tag:ct",
		});
		expect((parsed as unknown as { branches?: string[] }).branches).toBeUndefined();
	});
});

describe("normalizeGithubWebhook", () => {
	const repository = { full_name: "acme/site" };
	const sender = { login: "ana" };

	it("pull_request: opened/reopened/synchronize/closed(+merged)/closed/review_requested", () => {
		const pr = {
			number: 42,
			title: "Add feature",
			html_url: "https://github.com/acme/site/pull/42",
			user: { login: "ana" },
			head: { ref: "feature", sha: "abc123" },
			base: { ref: "main" },
		};
		const opened = normalizeGithubWebhook("pull_request", {
			action: "opened",
			repository,
			sender,
			pull_request: pr,
		});
		expect(opened[0]?.type).toBe("pr_opened");
		expect(opened[0]?.pr?.number).toBe(42);
		expect(opened[0]?.pr?.headSha).toBe("abc123");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "reopened",
				repository,
				sender,
				pull_request: pr,
			})[0]?.type,
		).toBe("pr_opened");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "synchronize",
				repository,
				sender,
				pull_request: pr,
			})[0]?.type,
		).toBe("pr_pushed");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "closed",
				repository,
				sender,
				pull_request: { ...pr, merged: true },
			})[0]?.type,
		).toBe("pr_merged");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "closed",
				repository,
				sender,
				pull_request: { ...pr, merged: false },
			})[0]?.type,
		).toBe("pr_closed");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "review_requested",
				repository,
				sender,
				pull_request: pr,
			})[0]?.type,
		).toBe("pr_review_requested");

		expect(
			normalizeGithubWebhook("pull_request", {
				action: "labeled",
				repository,
				sender,
				pull_request: pr,
			}),
		).toEqual([]);
	});

	it("pull_request_review submitted: approved/changes_requested/commented", () => {
		const pull_request = { number: 1, html_url: "https://x/pull/1" };
		const approved = normalizeGithubWebhook("pull_request_review", {
			action: "submitted",
			repository,
			sender,
			pull_request,
			review: { state: "approved", html_url: "https://x/pull/1#review", body: "lgtm" },
		});
		expect(approved[0]?.type).toBe("pr_approved");
		expect(approved[0]?.review?.state).toBe("approved");
		expect(approved[0]?.comment).toBeUndefined();

		const changes = normalizeGithubWebhook("pull_request_review", {
			action: "submitted",
			repository,
			sender,
			pull_request,
			review: { state: "changes_requested" },
		});
		expect(changes[0]?.type).toBe("pr_changes_requested");

		const commented = normalizeGithubWebhook("pull_request_review", {
			action: "submitted",
			repository,
			sender,
			pull_request,
			review: { state: "commented", body: "olha isso aqui" },
		});
		expect(commented[0]?.type).toBe("pr_commented");
		expect(commented[0]?.comment?.excerpt).toBe("olha isso aqui");

		expect(
			normalizeGithubWebhook("pull_request_review", {
				action: "dismissed",
				repository,
				sender,
				pull_request,
				review: { state: "approved" },
			}),
		).toEqual([]);
	});

	it("pull_request_review_comment created: inline com path/line", () => {
		const normalized = normalizeGithubWebhook("pull_request_review_comment", {
			action: "created",
			repository,
			sender,
			pull_request: { number: 5, html_url: "https://x/pull/5" },
			comment: {
				body: "isso quebra em produção",
				path: "src/index.ts",
				line: 10,
				html_url: "https://x/pull/5#comment",
			},
		});
		expect(normalized[0]?.type).toBe("pr_commented");
		expect(normalized[0]?.comment).toEqual({
			excerpt: "isso quebra em produção",
			path: "src/index.ts",
			line: 10,
			url: "https://x/pull/5#comment",
		});
	});

	it("pull_request_review_thread: resolved/unresolved", () => {
		const pull_request = { number: 3 };
		expect(
			normalizeGithubWebhook("pull_request_review_thread", {
				action: "resolved",
				repository,
				sender,
				pull_request,
			})[0]?.type,
		).toBe("pr_thread_resolved");
		expect(
			normalizeGithubWebhook("pull_request_review_thread", {
				action: "unresolved",
				repository,
				sender,
				pull_request,
			})[0]?.type,
		).toBe("pr_thread_unresolved");
	});

	it("issue_comment created: PR (conversation comment) mapeia pra pr_commented; issue pura é ignorada", () => {
		const onPr = normalizeGithubWebhook("issue_comment", {
			action: "created",
			repository,
			sender,
			issue: { number: 8, title: "PR title", html_url: "https://x/pull/8", pull_request: {} },
			comment: { body: "comentário na conversa do PR", html_url: "https://x/pull/8#c1" },
		});
		expect(onPr[0]?.type).toBe("pr_commented");
		expect(onPr[0]?.pr?.number).toBe(8);

		const onIssue = normalizeGithubWebhook("issue_comment", {
			action: "created",
			repository,
			sender,
			issue: { number: 9, title: "Bug", html_url: "https://x/issues/9" },
			comment: { body: "ainda acontece?", html_url: "https://x/issues/9#c1" },
		});
		expect(onIssue).toEqual([]);
	});

	it("issues: só assigned sobrevive (opened saiu do vocabulário)", () => {
		const issue = { number: 7, title: "Bug", html_url: "https://x/issues/7", assignee: { login: "ana" } };
		expect(normalizeGithubWebhook("issues", { action: "opened", repository, sender, issue })).toEqual([]);
		const assigned = normalizeGithubWebhook("issues", { action: "assigned", repository, sender, issue });
		expect(assigned[0]?.type).toBe("issue_assigned");
		expect(assigned[0]?.issue?.assignee).toBe("ana");
	});

	it("check_suite completed: success/failure/timed_out, com pr e failedChecks", () => {
		const passed = normalizeGithubWebhook("check_suite", {
			action: "completed",
			repository,
			sender,
			check_suite: {
				conclusion: "success",
				head_branch: "main",
				head_sha: "deadbeef",
				pull_requests: [{ number: 4 }],
			},
		});
		expect(passed[0]?.type).toBe("ci_passed");
		expect(passed[0]?.pr?.number).toBe(4);
		expect(passed[0]?.ci?.branch).toBe("main");

		const failed = normalizeGithubWebhook("check_suite", {
			action: "completed",
			repository,
			sender,
			check_suite: {
				conclusion: "failure",
				head_branch: "main",
				head_sha: "deadbeef",
				check_runs: Array.from({ length: 15 }, (_, i) => ({
					name: `job-${i}`,
					conclusion: "failure",
					html_url: `https://x/checks/${i}`,
				})),
			},
		});
		expect(failed[0]?.type).toBe("ci_failed");
		expect(failed[0]?.ci?.failedChecks.length).toBe(10);

		expect(
			normalizeGithubWebhook("check_suite", {
				action: "completed",
				repository,
				sender,
				check_suite: { conclusion: "neutral" },
			}),
		).toEqual([]);
		expect(
			normalizeGithubWebhook("check_suite", {
				action: "requested",
				repository,
				sender,
				check_suite: { conclusion: "success" },
			}),
		).toEqual([]);
	});

	it("release/star (fora do vocabulário) retornam array vazio", () => {
		expect(
			normalizeGithubWebhook("release", {
				action: "published",
				repository,
				sender,
				release: { tag_name: "v1.2.3" },
			}),
		).toEqual([]);
		expect(normalizeGithubWebhook("star", {})).toEqual([]);
	});

	it("push: branch normal vira evento normalizado com branch/commits/headSha/compareUrl e actor=pusher", () => {
		const normalized = normalizeGithubWebhook("push", {
			repository,
			sender,
			ref: "refs/heads/main",
			after: "abcdef1234567890",
			commits: [{}, {}, {}],
			compare: "https://github.com/acme/site/compare/abc...def",
			pusher: { name: "ana-pusher" },
		});
		expect(normalized[0]?.type).toBe("push");
		expect(normalized[0]?.actor).toBe("ana-pusher");
		expect(normalized[0]?.push).toEqual({
			branch: "main",
			commits: 3,
			headSha: "abcdef1234567890",
			compareUrl: "https://github.com/acme/site/compare/abc...def",
		});
	});

	it("push: deleted:true (deleção de branch) retorna array vazio", () => {
		expect(
			normalizeGithubWebhook("push", {
				repository,
				sender,
				ref: "refs/heads/feature-x",
				deleted: true,
			}),
		).toEqual([]);
	});

	it("push: ref de tag (refs/tags/…) retorna array vazio", () => {
		expect(
			normalizeGithubWebhook("push", {
				repository,
				sender,
				ref: "refs/tags/v1.0.0",
				after: "abc",
			}),
		).toEqual([]);
	});

	it("push: sem pusher.name cai pro sender.login", () => {
		const normalized = normalizeGithubWebhook("push", {
			repository,
			sender,
			ref: "refs/heads/main",
			after: "abc",
		});
		expect(normalized[0]?.actor).toBe("ana");
	});
});

describe("githubWebhookEventsFor", () => {
	it("mapeia eventos do trigger pros nomes de webhook do GitHub (dedup)", () => {
		expect(githubWebhookEventsFor(["pr_opened", "pr_merged"])).toEqual(["pull_request"]);
		expect(new Set(githubWebhookEventsFor(["pr_commented"]))).toEqual(
			new Set(["issue_comment", "pull_request_review", "pull_request_review_comment"]),
		);
		expect(githubWebhookEventsFor(["ci_passed", "ci_failed"])).toEqual(["check_suite"]);
		expect(githubWebhookEventsFor(["issue_assigned"])).toEqual(["issues"]);
		expect(githubWebhookEventsFor(["push"])).toEqual(["push"]);
	});
});

describe("githubEventMatchesTrigger", () => {
	it("repo diferente não casa (case-insensitive na comparação)", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_commented", repo: "ACME/SITE" },
				{ repo: "acme/site", events: ["pr_commented"] },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_commented", repo: "other/repo" },
				{ repo: "acme/site", events: ["pr_commented"] },
			),
		).toBe(false);
	});
	it("evento fora da seleção não casa", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "issue_assigned", repo: "acme/site" },
				{ repo: "acme/site", events: ["pr_opened"] },
			),
		).toBe(false);
	});
	it("prNumber: só casa o PR configurado", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_commented", repo: "acme/site", pr: { number: 5, title: "" } },
				{ repo: "acme/site", events: ["pr_commented"], prNumber: 5 },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_commented", repo: "acme/site", pr: { number: 6, title: "" } },
				{ repo: "acme/site", events: ["pr_commented"], prNumber: 5 },
			),
		).toBe(false);
	});
	it("users: filtra por ator case-insensitive", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "issue_assigned", repo: "acme/site", actor: "Ana" },
				{ repo: "acme/site", events: ["issue_assigned"], users: ["ana"] },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "issue_assigned", repo: "acme/site", actor: "outro" },
				{ repo: "acme/site", events: ["issue_assigned"], users: ["ana"] },
			),
		).toBe(false);
	});
	it("users não se aplica a eventos ci_*", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "ci_failed", repo: "acme/site", actor: "github-actions", ci: { branch: "main" } as never },
				{ repo: "acme/site", events: ["ci_failed"], users: ["ana"], branch: "main" },
			),
		).toBe(true);
	});
	it("ci_* sem prNumber exige branch bater", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "ci_failed", repo: "acme/site", ci: { branch: "main" } as never },
				{ repo: "acme/site", events: ["ci_failed"], branch: "main" },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "ci_failed", repo: "acme/site", ci: { branch: "dev" } as never },
				{ repo: "acme/site", events: ["ci_failed"], branch: "main" },
			),
		).toBe(false);
	});
	it("ci_* com prNumber ignora branch (babá de PR cobre o caso)", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "ci_failed", repo: "acme/site", pr: { number: 9, title: "" } },
				{ repo: "acme/site", events: ["ci_failed"], prNumber: 9 },
			),
		).toBe(true);
	});
	it("push: sem branch configurada, qualquer branch casa", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "push", repo: "acme/site", push: { branch: "feature-x" } as never },
				{ repo: "acme/site", events: ["push"] },
			),
		).toBe(true);
	});
	it("push: com branch configurada (sem prNumber), só a branch bate", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "push", repo: "acme/site", push: { branch: "main" } as never },
				{ repo: "acme/site", events: ["push"], branch: "main" },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "push", repo: "acme/site", push: { branch: "dev" } as never },
				{ repo: "acme/site", events: ["push"], branch: "main" },
			),
		).toBe(false);
	});
	it("pr_*: com branch configurada (sem prNumber), exige pr.base === branch", () => {
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_opened", repo: "acme/site", pr: { number: 1, title: "x", base: "main" } },
				{ repo: "acme/site", events: ["pr_opened"], branch: "main" },
			),
		).toBe(true);
		expect(
			githubEventMatchesTrigger(
				{ type: "pr_opened", repo: "acme/site", pr: { number: 1, title: "x", base: "dev" } },
				{ repo: "acme/site", events: ["pr_opened"], branch: "main" },
			),
		).toBe(false);
	});
});

describe("describeGithubTrigger", () => {
	it("repo-wide: eventos de PR combinam numa frase natural", () => {
		expect(
			describeGithubTrigger({
				repo: "ali-ali18/agent-bot",
				events: ["pr_opened", "pr_merged"],
			}),
		).toBe("um PR é aberto ou mergeado em `ali-ali18/agent-bot`");
	});
	it("repo-wide: CI-only referencia a branch", () => {
		expect(
			describeGithubTrigger({
				repo: "acme/site",
				events: ["ci_failed"],
				branch: "main",
			}),
		).toBe("o CI falha na branch `main` em `acme/site`");
	});
	it("repo-wide: CI passa e falha juntos", () => {
		expect(
			describeGithubTrigger({
				repo: "acme/site",
				events: ["ci_failed", "ci_passed"],
				branch: "main",
			}),
		).toBe("o CI falha ou passa na branch `main` em `acme/site`");
	});
	it("repo-wide: push referencia a branch", () => {
		expect(
			describeGithubTrigger({
				repo: "acme/site",
				events: ["push"],
				branch: "main",
			}),
		).toBe("há um push na branch `main` em `acme/site`");
	});
	it("repo-wide: PR lifecycle com branch (sem prNumber) referencia a branch", () => {
		expect(
			describeGithubTrigger({
				repo: "acme/site",
				events: ["pr_opened", "pr_merged"],
				branch: "main",
			}),
		).toBe("um PR para a branch `main` é aberto ou mergeado em `acme/site`");
	});
	it("babá de PR: com users, adiciona nota de filtro no final", () => {
		const description = describeGithubTrigger({
			repo: "owner/repo",
			events: GITHUB_PR_BABYSIT_EVENTS,
			prNumber: 42,
			users: ["a", "b"],
		});
		expect(description).toContain("algo acontece no PR #42 de `owner/repo`");
		expect(description).toContain("a rotina se apaga quando o PR fechar");
		expect(description.endsWith("(só de @a, @b)")).toBe(true);
	});
	it("babá de PR: sem users, não adiciona nota de filtro", () => {
		const description = describeGithubTrigger({
			repo: "owner/repo",
			events: ["pr_merged"],
			prNumber: 42,
		});
		expect(description).toBe(
			"algo acontece no PR #42 de `owner/repo` (merge) — a rotina se apaga quando o PR fechar",
		);
	});
	it("events vazio não lança e ainda produz frase sensata", () => {
		expect(describeGithubTrigger({ repo: "acme/site", events: [] })).toBe(
			"algo acontece em `acme/site`",
		);
		expect(describeGithubTrigger({ repo: "acme/site", events: [], prNumber: 3 })).toBe(
			"algo acontece no PR #3 de `acme/site` — a rotina se apaga quando o PR fechar",
		);
	});
});

describe("describeGithubTriggerClauses", () => {
	it("lifecycle de PR: uma cláusula 'Quando ...' juntando os eventos", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "ali-ali18/agent-bot",
				events: ["pr_opened", "pr_merged"],
			}),
		).toEqual([
			"Quando um PR for aberto ou um PR for mesclado em ali-ali18/agent-bot",
		]);
	});

	it("CI: cláusula com a branch", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "ali-ali18/agent-bot",
				events: ["ci_failed"],
				branch: "checkpoint/agentic-baseline",
			}),
		).toEqual([
			"Quando o CI falhar na branch checkpoint/agentic-baseline em ali-ali18/agent-bot",
		]);
	});

	it("CI: falha e passa juntos, sem nota de users (CI é isento)", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "acme/site",
				events: ["ci_failed", "ci_passed"],
				branch: "main",
				users: ["ana"],
			}),
		).toEqual(["Quando o CI falhar ou passar na branch main em acme/site"]);
	});

	it("push: cláusula com a branch", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "owner/repo",
				events: ["push"],
				branch: "X",
			}),
		).toEqual(["Quando houver push na branch X em owner/repo"]);
	});

	it("push: sem branch, cláusula genérica", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "owner/repo",
				events: ["push"],
			}),
		).toEqual(["Quando houver push em owner/repo"]);
	});

	it("PR lifecycle com branch (sem prNumber): um sujeito só, verbos unidos", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "owner/repo",
				events: ["pr_opened", "pr_merged"],
				branch: "X",
			}),
		).toEqual(["Quando um PR para a branch X for aberto ou mesclado em owner/repo"]);
	});

	it("babá de PR: CI referencia '#N' em vez da branch", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "owner/repo",
				events: ["ci_failed"],
				prNumber: 42,
			}),
		).toEqual(["Quando o CI falhar no PR #42 em owner/repo"]);
	});

	it("reviews juntas numa cláusula; comentário e threads em cláusulas próprias", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "acme/site",
				events: [
					"pr_review_requested",
					"pr_approved",
					"pr_changes_requested",
					"pr_commented",
					"pr_thread_resolved",
					"pr_thread_unresolved",
				],
			}),
		).toEqual([
			"Quando alguém solicitar uma revisão, aprovar o PR ou pedir mudanças no PR em acme/site",
			"Quando alguém comentar no PR em acme/site",
			"Quando alguém resolver uma thread de revisão ou reabrir uma thread de revisão em acme/site",
		]);
	});

	it("issue atribuída: cláusula própria", () => {
		expect(
			describeGithubTriggerClauses({
				repo: "acme/site",
				events: ["issue_assigned"],
			}),
		).toEqual(["Quando uma issue for atribuída em acme/site"]);
	});

	it("filtro de users aparece só nas cláusulas não-CI", () => {
		const clauses = describeGithubTriggerClauses({
			repo: "acme/site",
			events: ["pr_opened", "ci_failed"],
			branch: "main",
			users: ["a", "b"],
		});
		expect(clauses).toEqual([
			"Quando um PR para a branch main for aberto em acme/site (só de @a, @b)",
			"Quando o CI falhar na branch main em acme/site",
		]);
	});

	it("babá de PR: cláusulas não-CI mencionam '#N'", () => {
		const clauses = describeGithubTriggerClauses({
			repo: "owner/repo",
			events: ["pr_merged", "pr_commented"],
			prNumber: 7,
		});
		expect(clauses).toEqual([
			"Quando o PR #7 for mesclado em owner/repo",
			"Quando alguém comentar no PR #7 em owner/repo",
		]);
	});

	it("sem eventos reconhecidos: array vazio", () => {
		expect(describeGithubTriggerClauses({ repo: "acme/site", events: [] })).toEqual([]);
	});
});

describe("GITHUB_ROUTINE_TEMPLATES", () => {
	it("todo evento de todo template é um GithubTriggerEvent válido", () => {
		for (const template of GITHUB_ROUTINE_TEMPLATES) {
			for (const event of template.events) {
				expect(isGithubTriggerEvent(event)).toBe(true);
			}
		}
	});
	it("templates com evento de CI pedem ciBranch ou prNumber", () => {
		for (const template of GITHUB_ROUTINE_TEMPLATES) {
			const hasCiEvent = template.events.some((event) =>
				(GITHUB_CI_EVENTS as readonly string[]).includes(event),
			);
			if (!hasCiEvent) continue;
			const asksEnough = template.asks.includes("ciBranch") || template.asks.includes("prNumber");
			expect(asksEnough).toBe(true);
		}
	});
	it("todo template pede repo", () => {
		for (const template of GITHUB_ROUTINE_TEMPLATES) {
			expect(template.asks).toContain("repo");
		}
	});
	it("ids são únicos", () => {
		const ids = GITHUB_ROUTINE_TEMPLATES.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
	it("inclui o template 'Acompanhar uma branch' (push + PR aberto/mesclado)", () => {
		const template = GITHUB_ROUTINE_TEMPLATES.find((t) => t.id === "branch_watch");
		expect(template).toBeDefined();
		expect(template?.events).toEqual(["push", "pr_opened", "pr_merged"]);
		expect(template?.asks).toContain("repo");
		expect(template?.asks).toContain("ciBranch");
	});
	it("todo defaultPrompt (exceto pr_babysit, que tem instrução própria) segue a estrutura fixa: intro + 1 bullet por evento + regra de só ler", () => {
		for (const template of GITHUB_ROUTINE_TEMPLATES) {
			if (template.id === "pr_babysit") continue; // instrução própria (resumo desde a última vez), não segue o bullet-per-event.
			expect(template.defaultPrompt).toContain("Leia o evento que veio junto");
			expect(template.defaultPrompt).toContain(
				"Nunca comente, aprove, faça push ou altere nada no GitHub",
			);
			const bulletLines = template.defaultPrompt
				.split("\n")
				.filter((line) => line.startsWith("- "));
			expect(bulletLines.length).toBe(template.events.length);
		}
	});
});

describe("buildGithubRoutinePromptDetail", () => {
	it("intro + 1 bullet por evento + regra de só ler, sem branch", () => {
		const detail = buildGithubRoutinePromptDetail({ events: ["pr_opened", "pr_merged"] });
		const lines = detail.split("\n");
		expect(lines[0]).toBe(
			"Um evento do GitHub neste repositório me acordou. Leia o evento que veio junto e avise em português, de forma curta e clara:",
		);
		expect(detail).toContain("- PR aberto: ");
		expect(detail).toContain("- PR mergeado: ");
		expect(detail).toContain(
			"Nunca comente, aprove, faça push ou altere nada no GitHub; só leia e avise. Se o evento não tiver informação suficiente, avise mesmo assim com o que tiver e o link.",
		);
	});
	it("evento ci_*/push com branch: o bullet menciona a branch", () => {
		const detail = buildGithubRoutinePromptDetail({ events: ["ci_failed"], branch: "main" });
		expect(detail).toContain("- CI falhou na branch main: ");
	});
	it("evento push com branch: o bullet menciona a branch", () => {
		const detail = buildGithubRoutinePromptDetail({ events: ["push"], branch: "main" });
		expect(detail).toContain("- Push na branch main: ");
	});
	it("nunca lança pra lista de eventos vazia", () => {
		expect(() => buildGithubRoutinePromptDetail({ events: [] })).not.toThrow();
	});
});

describe("vocabulário v4: push voltou, demais eventos removidos continuam fora", () => {
	it("push está em GITHUB_TRIGGER_EVENTS; release/issue_opened/issue_commented continuam fora", () => {
		expect(GITHUB_TRIGGER_EVENTS).toContain("push");
		expect(GITHUB_TRIGGER_EVENTS).not.toContain("release");
		expect(GITHUB_TRIGGER_EVENTS).not.toContain("issue_opened");
		expect(GITHUB_TRIGGER_EVENTS).not.toContain("issue_commented");
	});
});
