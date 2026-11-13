// Fake tipado da porta `Sandbox` para a capacidade `code` (F8.2): o workspace é um mapa em memória por (dono, sessão) e o
// protocolo é o de `capabilities/code/kinds.ts`. Mesmas recusas da VM: sessão de outro dono é "not found" (nunca "forbidden"),
// edição ambígua é recusada, `.env` e afins não são tratados aqui (isso é do portão da capacidade, antes da porta).
// Comando: o fake NÃO executa nada sozinho; quem monta injeta `exec` (o eval roda o shell de verdade numa cópia em disco;
// o teste unitário responde por roteiro). Sem `exec`, o comando falha de forma honesta.
import type { Sandbox, SandboxAction, SandboxResult } from "../ports/sandbox.js";
import { isSensitiveEnvFile } from "@workspace/shared";
import { CODE_KINDS, codeParams, isCodeKind } from "../capabilities/code/kinds.js";
import { applyEdit } from "./code-edit-match.js";

export type FakeCodeExec = (input: { cmd: string; cwd?: string; files: ReadonlyMap<string, string>; kind: "shell" | "test" }) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean; files?: ReadonlyMap<string, string> }> | { exitCode: number | null; output: string; timedOut?: boolean; files?: ReadonlyMap<string, string> };

/** Modelo mínimo de git/GitHub por sessão (F9): commits à frente da base, o que foi enviado e o que o CI devolve. */
type FakeGit = { ahead: number; sha: string; remote: Map<string, string> };
export type FakeCodeCi = { pr?: { number: number; url: string; state: string; title: string; base: string; head: string }; summary: "none" | "pending" | "passing" | "failing"; checks: Array<{ name: string; status: string; conclusion: string | null; url?: string; durationMs?: number; jobId?: number }> };
type Workspace = { id: string; ownerId: string; repo?: string; branch?: string; files: Map<string, string>; baseline: Map<string, string>; git: FakeGit };
const DEFAULT_BRANCH = "main";

export type FakeCodeCall = { ownerId: string; kind: string; params: unknown };

const clean = (path: string): string => path.replace(/^\/workspace\/?/, "").replace(/^\.\//, "");

function lineDiff(path: string, before: string, after: string): { diff: string; added: number; removed: number } {
	const a = before.split("\n");
	const b = after.split("\n");
	const removed = a.filter((line) => !b.includes(line));
	const added = b.filter((line) => !a.includes(line));
	const diff = [`--- a/${path}`, `+++ b/${path}`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
	return { diff, added: added.length, removed: removed.length };
}

export class FakeCodeSandbox implements Sandbox {
	readonly calls: FakeCodeCall[] = [];
	readonly released: Array<{ ownerId: string; runId: string }> = [];
	private readonly workspaces = new Map<string, Workspace>();
	private seq = 0;

	/** Pushes pedidos (para o teste conferir que nunca houve força nem a branch padrão). */
	readonly pushes: Array<{ ownerId: string; repo: string; branch: string }> = [];

	constructor(private readonly options: { seed?: Record<string, string>; exec?: FakeCodeExec; testCommand?: string; ci?: FakeCodeCi; jobLogs?: Record<number, string>; existingPr?: { number: number; url: string; state: string; title: string } } = {}) {}

	/** Arquivos da sessão, para o teste conferir o resultado. */
	files(sessionId: string): Map<string, string> | undefined {
		return this.workspaces.get(sessionId)?.files;
	}

	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.calls.push({ ownerId: userId, kind: action.kind, params: action.params });
		if (!isCodeKind(action.kind)) return { ok: false, error: `Unknown action ${action.kind}.` };
		try {
			return { ok: true, data: await this.handle(userId, action.kind, action.params) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async release(userId: string, runId: string): Promise<void> {
		this.released.push({ ownerId: userId, runId });
	}

	private open(userId: string, sessionId: string): Workspace {
		const ws = this.workspaces.get(sessionId);
		// Mesma resposta para "não existe" e "é de outro dono".
		if (!ws || ws.ownerId !== userId) throw new Error("Coding session not found.");
		return ws;
	}

	private async handle(userId: string, kind: string, raw: unknown): Promise<unknown> {
		switch (kind) {
			case CODE_KINDS.session: {
				const p = codeParams.session.parse(raw);
				if (p.sessionId) {
					const ws = this.open(userId, p.sessionId);
					return { sessionId: ws.id, repo: ws.repo, branch: ws.branch, status: "RUNNING", ...(this.options.testCommand && { testCommand: this.options.testCommand }) };
				}
				const id = `sess-${++this.seq}`;
				const files = new Map(Object.entries(this.options.seed ?? {}));
				this.workspaces.set(id, { id, ownerId: userId, ...(p.repo && { repo: p.repo }), ...(p.branch && { branch: p.branch }), files, baseline: new Map(files), git: { ahead: 0, sha: "sha0", remote: new Map([[DEFAULT_BRANCH, "sha0"]]) } });
				return { sessionId: id, repo: p.repo, branch: p.branch, status: "RUNNING", ...(this.options.testCommand && { testCommand: this.options.testCommand }) };
			}
			case CODE_KINDS.list: {
				const p = codeParams.list.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const prefix = p.path ? `${clean(p.path).replace(/\/$/, "")}/` : "";
				const entries = [...ws.files.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, text]) => ({ path: path.slice(prefix.length), type: "file" as const, size: text.length }));
				return { path: p.path ?? "/workspace", entries, total: entries.length, truncated: false };
			}
			case CODE_KINDS.read: {
				const p = codeParams.read.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const text = ws.files.get(clean(p.path));
				if (text === undefined) throw new Error(`File not found: ${p.path}`);
				const lines = text.split("\n");
				const offset = p.offset ?? 0;
				const limit = p.limit ?? 2000;
				const slice = lines.slice(offset, offset + limit);
				const next = offset + limit < lines.length ? offset + limit : null;
				return { path: clean(p.path), content: slice.join("\n"), totalLines: lines.length, startLine: offset + 1, endLine: offset + slice.length, nextOffset: next, kind: "text" };
			}
			case CODE_KINDS.edit: {
				const p = codeParams.edit.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const path = clean(p.path);
				const before = ws.files.get(path);
				if (before === undefined) throw new Error(`File not found: ${p.path}`);
				const out = applyEdit(before, p.old, p.new, p.replaceAll === true);
				if (!out.ok) throw new Error(out.error);
				ws.files.set(path, out.text);
				return { path, ...lineDiff(path, before, out.text), ...(out.note && { note: out.note }) };
			}
			case CODE_KINDS.write: {
				const p = codeParams.write.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const path = clean(p.path);
				const before = ws.files.get(path);
				ws.files.set(path, p.content);
				return { path, created: before === undefined, bytes: p.content.length, ...lineDiff(path, before ?? "", p.content) };
			}
			case CODE_KINDS.shell:
			case CODE_KINDS.test: {
				const p = codeParams.shell.parse(raw);
				const ws = this.open(userId, p.sessionId);
				if (!this.options.exec) throw new Error("No command runner is configured in this environment.");
				const result = await this.options.exec({ cmd: p.cmd, ...(p.cwd && { cwd: p.cwd }), files: ws.files, kind: kind === CODE_KINDS.test ? "test" : "shell" });
				if (result.files) ws.files = new Map(result.files);
				return { exitCode: result.exitCode, output: result.output, ...(result.timedOut && { timedOut: true }), durationMs: 1 };
			}
			case CODE_KINDS.gitStatus: {
				const p = codeParams.gitStatus.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const files = this.changed(ws).map((path) => ({ status: ws.baseline.has(path) ? "M" : "??", path }));
				return { branch: ws.branch ?? DEFAULT_BRANCH, files, clean: files.length === 0 };
			}
			case CODE_KINDS.diff: {
				const p = codeParams.diff.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const paths = this.changed(ws).filter((path) => !p.path || path === clean(p.path));
				const diff = paths.map((path) => lineDiff(path, ws.baseline.get(path) ?? "", ws.files.get(path) ?? "").diff).join("\n");
				return { diff, empty: paths.length === 0 };
			}
			case CODE_KINDS.commit: {
				const p = codeParams.commit.parse(raw);
				const ws = this.open(userId, p.sessionId);
				const head = ws.branch ?? DEFAULT_BRANCH;
				if (!p.branch && head === DEFAULT_BRANCH) throw new Error("Refused: the workspace is on the default branch (main). Pass `branch` with a new branch name to commit the change there.");
				if (p.branch === DEFAULT_BRANCH) throw new Error("Refused: main is the default branch. Pick a new branch name for the change.");
				const paths = this.changed(ws).filter((path) => !p.paths || p.paths.map(clean).includes(path));
				if (paths.length === 0) throw new Error("Nothing to commit: there are no changes in the workspace.");
				const secret = paths.filter((path) => isSensitiveEnvFile(path));
				if (secret.length > 0) throw new Error(`Refused: secret files would be committed (${secret.join(", ")}). Nothing was committed and the stage was undone.`);
				for (const path of paths) ws.baseline.set(path, ws.files.get(path) ?? "");
				ws.branch = p.branch ?? head;
				ws.git.ahead += 1;
				ws.git.sha = `sha${ws.git.ahead}-${ws.branch}`;
				return { sha: ws.git.sha, branch: ws.branch, subject: p.message.split("\n")[0] ?? "", files: paths.length, ...(p.branch && { createdBranch: true }) };
			}
			case CODE_KINDS.push: {
				const p = codeParams.push.parse(raw);
				const ws = this.open(userId, p.sessionId);
				if (!ws.repo) throw new Error("This session has no GitHub repository (owner/name). Open a session with a repo first.");
				const head = ws.branch ?? DEFAULT_BRANCH;
				if (head === DEFAULT_BRANCH || head === "master") throw new Error(`Refused: ${head} is the default branch and is never pushed from here. Commit on a new branch (code_commit with branch) and push that one.`);
				const isNew = !ws.git.remote.has(head);
				ws.git.remote.set(head, ws.git.sha);
				this.pushes.push({ ownerId: userId, repo: ws.repo, branch: head });
				return { branch: head, repo: ws.repo, sha: ws.git.sha, newBranch: isNew, url: `https://github.com/${ws.repo}/tree/${head}` };
			}
			case CODE_KINDS.prPrepare: {
				const p = codeParams.prPrepare.parse(raw);
				const ws = this.open(userId, p.sessionId);
				if (!ws.repo) throw new Error("This session has no GitHub repository (owner/name). Open a session with a repo first.");
				const head = ws.branch ?? DEFAULT_BRANCH;
				const changed = this.changed(ws).length;
				return { repo: ws.repo, head, base: p.base ?? DEFAULT_BRANCH, ahead: ws.git.ahead, files: ws.git.ahead > 0 ? 1 : 0, dirty: changed, pushed: ws.git.remote.get(head) === ws.git.sha, ...(this.options.existingPr && head !== DEFAULT_BRANCH && { existingPr: this.options.existingPr }) };
			}
			case CODE_KINDS.ci: {
				const p = codeParams.ci.parse(raw);
				const ws = this.open(userId, p.sessionId);
				if (!ws.repo) throw new Error("This session has no GitHub repository (owner/name). Open a session with a repo first.");
				const ci = this.options.ci;
				return ci?.pr ? { repo: ws.repo, pr: ci.pr, summary: ci.summary, checks: ci.checks } : { repo: ws.repo, pr: null, summary: "none", checks: [], note: "Push the branch (code_push) and open one first." };
			}
			case CODE_KINDS.ciLog: {
				const p = codeParams.ciLog.parse(raw);
				const ws = this.open(userId, p.sessionId);
				if (!ws.repo) throw new Error("This session has no GitHub repository (owner/name). Open a session with a repo first.");
				const text = this.options.jobLogs?.[p.jobId];
				if (text === undefined) throw new Error(`Job ${p.jobId} was not found.`);
				const limit = p.limit ?? 6_000;
				const start = Math.min(p.offset ?? Math.max(0, text.length - limit), text.length);
				const end = Math.min(text.length, start + limit);
				return { jobId: p.jobId, text: text.slice(start, end), startOffset: start, endOffset: end, totalChars: text.length, previousOffset: start > 0 ? Math.max(0, start - limit) : null, nextOffset: end < text.length ? end : null };
			}
		}
		throw new Error(`Unhandled ${kind}`);
	}

	private changed(ws: Workspace): string[] {
		return [...new Set([...ws.files.keys(), ...ws.baseline.keys()])].filter((path) => ws.files.get(path) !== ws.baseline.get(path)).sort();
	}
}
