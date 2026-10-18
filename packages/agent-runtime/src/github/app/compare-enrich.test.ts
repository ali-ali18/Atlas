import { describe, expect, it, vi } from "vitest";
import type { NormalizedGithubEvent } from "@workspace/shared";
import { COMPARE_OUTPUT_MAX_CHARS, fetchCompare, formatCompareForModel, type CompareData } from "./compare.js";
import { enrichGithubEvent } from "./enrich.js";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ghCommit(n: number) {
	return {
		sha: `${String(n).padStart(2, "0")}${"a".repeat(38)}`,
		html_url: `https://github.com/acme/site/commit/${n}`,
		commit: { message: `commit ${n}\n\ncorpo do commit ${n}`, author: { name: "Ana" } },
		author: { login: "ana" },
	};
}

/** 130 commits em 2 páginas (100 + 30); arquivos só na primeira página. */
function compareFetch() {
	return vi.fn(async (input: unknown) => {
		const url = String(input);
		if (url.includes("/compare/")) {
			const page = Number(new URL(url).searchParams.get("page"));
			const all = Array.from({ length: 130 }, (_, i) => ghCommit(i + 1));
			return json({
				status: "ahead",
				ahead_by: 130,
				behind_by: 0,
				total_commits: 130,
				html_url: "https://github.com/acme/site/compare/a...b",
				commits: page === 1 ? all.slice(0, 100) : page === 2 ? all.slice(100) : [],
				files:
					page === 1
						? [
								{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ a" },
								{ filename: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "@@ b" },
							]
						: [],
			});
		}
		if (url.includes("/commits/")) {
			return json({ stats: { additions: 3, deletions: 1 }, files: [{}, {}] });
		}
		return json({ message: "nope" }, 404);
	}) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

describe("fetchCompare", () => {
	it("pagina (2 páginas), junta os 130 commits e soma arquivos sem patch", async () => {
		const fetchFn = compareFetch();
		const res = await fetchCompare({ token: "t", repo: "acme/site", base: "main", head: "feat/x", fetchFn });
		if (res.error) throw new Error("falhou");
		expect(res.data.totalCommits).toBe(130);
		expect(res.data.commits).toHaveLength(130);
		expect(res.data.commitsTruncated).toBe(false);
		expect(res.data.commits[0]).toMatchObject({ subject: "commit 1", author: "ana" });
		expect(res.data.commits[0]!.body).toContain("corpo do commit 1");
		expect(res.data.additions).toBe(15);
		expect(res.data.deletions).toBe(2);
		expect(res.data.files.every((f) => f.patch === undefined)).toBe(true);
		const urls = fetchFn.mock.calls.map((c) => String(c[0]));
		expect(urls.filter((u) => u.includes("/compare/"))).toHaveLength(2);
		expect(urls[0]).toContain("per_page=100&page=1");
		expect(urls[1]).toContain("page=2");
		expect(urls[0]).toContain("main...feat/x");
	});

	it("includePatch só com até 20 arquivos", async () => {
		const res = await fetchCompare({ token: "t", repo: "acme/site", base: "a", head: "b", fetchFn: compareFetch(), includePatch: true });
		if (res.error) throw new Error("falhou");
		expect(res.data.files[0]!.patch).toBe("@@ a");
		const big = vi.fn(async () =>
			json({ total_commits: 1, commits: [ghCommit(1)], files: Array.from({ length: 25 }, (_, i) => ({ filename: `f${i}`, status: "modified", additions: 1, deletions: 0, patch: "x" })) }),
		) as unknown as typeof fetch;
		const res2 = await fetchCompare({ token: "t", repo: "acme/site", base: "a", head: "b", fetchFn: big, includePatch: true });
		if (res2.error) throw new Error("falhou");
		expect(res2.data.files.every((f) => f.patch === undefined)).toBe(true);
		expect(res2.data.patchOmittedReason).toMatch(/25 arquivos/);
	});

	it("devolve erro do GitHub na primeira página", async () => {
		const fetchFn = vi.fn(async () => json({ message: "Not Found" }, 404)) as unknown as typeof fetch;
		const res = await fetchCompare({ token: "t", repo: "acme/site", base: "a", head: "b", fetchFn });
		expect(res.error).toEqual({ status: 404, message: "Not Found" });
	});
});

describe("formatCompareForModel: forma e truncamento", () => {
	function data(commits: number, files: number): CompareData {
		return {
			repo: "acme/site",
			base: "a",
			head: "b",
			status: "ahead",
			aheadBy: commits,
			behindBy: 0,
			totalCommits: commits,
			commits: Array.from({ length: commits }, (_, i) => ({ sha: `${String(i).padStart(7, "0")}${"f".repeat(33)}`, subject: `mudança número ${i} ${"x".repeat(80)}`, author: "ana", files: 2 })),
			commitsTruncated: false,
			files: Array.from({ length: files }, (_, i) => ({ path: `src/muito/longo/caminho/arquivo-${i}.ts`, status: "modified", additions: 1, deletions: 1 })),
			filesTotal: files,
			filesTruncated: false,
			additions: files,
			deletions: files,
		};
	}

	it("cabeçalho, commits primeiro e arquivos depois", () => {
		const text = formatCompareForModel(data(3, 2));
		expect(text.indexOf("COMMITS:")).toBeGreaterThan(0);
		expect(text.indexOf("COMMITS:")).toBeLessThan(text.indexOf("FILES:"));
		expect(text).toContain("commits=3 listed=3");
		expect(text).toContain("M src/muito/longo/caminho/arquivo-0.ts +1 -1");
	});

	it("com 200 commits e 300 arquivos cabe no teto, mantém TODOS os commits e corta arquivos", () => {
		const text = formatCompareForModel(data(200, 300));
		expect(text.length).toBeLessThanOrEqual(COMPARE_OUTPUT_MAX_CHARS);
		for (let i = 1; i <= 200; i += 1) expect(text).toContain(`\n${i}. `);
		expect(text).toMatch(/\[\d+ more files not shown\]/);
	});
});

describe("enriquecimento do webhook", () => {
	const pushEvent: NormalizedGithubEvent = {
		type: "push",
		repo: "acme/site",
		actor: "ana",
		push: { branch: "main", commits: 20, headSha: "b".repeat(40) },
	};
	const payload = { before: "a".repeat(40), after: "b".repeat(40), repository: { default_branch: "main" } };

	it("push: lista completa (2 páginas) e total real no lugar da contagem do payload", async () => {
		const out = await enrichGithubEvent({ event: pushEvent, payload, token: "t", fetchFn: compareFetch() });
		expect(out.push?.commits).toBe(130);
		expect(out.push?.commitList).toHaveLength(130);
		expect(out.push?.summary).toEqual({ files: 2, additions: 15, deletions: 2 });
		expect(out.push?.commitList?.[0]).toMatchObject({ files: 2, additions: 3, deletions: 1 });
		expect(JSON.stringify(out)).not.toContain("@@ a");
		expect(pushEvent.push?.commits).toBe(20);
	});

	it("push de branch nova compara com a branch padrão; sem base nem token útil devolve o original", async () => {
		const fetchFn = compareFetch();
		const created = await enrichGithubEvent({
			event: { ...pushEvent, push: { ...pushEvent.push!, branch: "feat" } },
			payload: { before: "0".repeat(40), after: "b".repeat(40), repository: { default_branch: "main" } },
			token: "t",
			fetchFn,
		});
		expect(created.push?.commitList).toHaveLength(130);
		expect(String(fetchFn.mock.calls[0]![0])).toContain("main...");
		const same = await enrichGithubEvent({ event: pushEvent, payload: { before: "0".repeat(40), after: "b".repeat(40) }, token: "t", fetchFn });
		expect(same).toBe(pushEvent);
	});

	it("erro no compare nunca derruba o evento", async () => {
		const fetchFn = vi.fn(async () => json({ message: "x" }, 500)) as unknown as typeof fetch;
		const out = await enrichGithubEvent({ event: pushEvent, payload, token: "t", fetchFn });
		expect(out).toBe(pushEvent);
	});

	it("PR: título/corpo limitado, contagem de commits e arquivos com estatística", async () => {
		const fetchFn = vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.includes("/files")) {
				return json([{ filename: "a.ts", status: "added", additions: 4, deletions: 0, patch: "SECRETO" }]);
			}
			return json({ body: "d".repeat(3000), commits: 7, changed_files: 1, additions: 4, deletions: 0 });
		}) as unknown as typeof fetch;
		const out = await enrichGithubEvent({
			event: { type: "pr_opened", repo: "acme/site", pr: { number: 5, title: "Nova coisa" } },
			payload: {},
			token: "t",
			fetchFn,
		});
		expect(out.pr).toMatchObject({ number: 5, title: "Nova coisa", commitsCount: 7, changedFiles: 1, additions: 4 });
		expect(out.pr?.body!.length).toBeLessThanOrEqual(1501);
		expect(out.pr?.fileList).toEqual([{ path: "a.ts", status: "added", additions: 4, deletions: 0 }]);
		expect(JSON.stringify(out)).not.toContain("SECRETO");
	});
});
