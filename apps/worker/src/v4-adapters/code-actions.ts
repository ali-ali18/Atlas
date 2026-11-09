// Adaptador das ações `code.*` (F8.2) sobre a VM de desenvolvimento (`packages/sandbox/src/dev/*`). O formato das ações e
// dos resultados é o de `packages/agent/src/capabilities/code/kinds.ts` (os schemas daqui são os de lá).
//
// ESCOPO: usuário + sessão. Toda ação procura a sessão por `{ id, userId }` (`deps.sessions.get`); sessão de outro dono responde
// "Coding session not found." (igual a "não existe", nunca "forbidden"). O `userId` vem do run (porta `Sandbox.run(userId, …)`),
// nunca de `params`.
//
// DEFESA EM PROFUNDIDADE: a capacidade já aplica o portão de comando, mas esta é a fronteira com a VM: comando de bloqueio
// fixo é recusado de novo aqui, o caminho é conferido de novo, a saída e o erro passam por `redactSecrets` (com os segredos
// da sessão) e todo resultado é validado pelos mesmos schemas que a capacidade espera.
//
// INTEGRAÇÃO (para quem monta `v4-adapters/sandbox.ts`, frente A): este módulo NÃO é um `Sandbox`; é um tratador por kind.
//   const code = createCodeActionHandler(deps);
//   if (code.handles(action.kind)) return code.run(userId, action, signal);
// `CodeActionHandler` é definido aqui de propósito (a frente A pode ter o seu tipo; o contrato é só esta assinatura).
import { CODE_KIND_LIST, CODE_KINDS, type CodeKind, classifyShell, codeParams, codeResults, isCodeKind, type SandboxAction, type SandboxResult } from "@workspace/agent";
import type { DevClient, DevExecSnapshot } from "@workspace/sandbox";
import { DevSandboxError } from "@workspace/sandbox";
import { cleanJobLog, jobLogErrors } from "@workspace/github";
import { type DevCiCheck, type DevCiSummary, type DevPrInfo, fullSuiteAdvice, isFullSuiteTestCommand, isSafeGitRef, isSensitiveEnvFile, redactSecrets } from "@workspace/shared";
import type { z } from "zod";

export type CodeActionHandler = {
	handles(kind: string): kind is CodeKind;
	run(userId: string, action: SandboxAction, signal?: AbortSignal): Promise<SandboxResult>;
};

/** Sessão de código como o adaptador a enxerga (um recorte de `DevSessionRecord`). */
export type CodeSession = { id: string; userId: string; repo: string | null; branch: string | null; status: string };

export type CodeActionDeps = {
	sessions: {
		/** Sessão do dono, ou `null` (não existe OU é de outro): a consulta filtra por `{ id, userId }`. */
		get(id: string, userId: string): Promise<CodeSession | null>;
		create(userId: string, input: { repo?: string; branch?: string }): Promise<CodeSession>;
		touch?(id: string, userId: string): Promise<void>;
	};
	/** Garante o ambiente rodando e devolve o cliente HTTP da VM. Lança com mensagem clara se estiver na fila. */
	connect(session: CodeSession, signal?: AbortSignal): Promise<DevClient>;
	/**
	 * Sessão nova: clona o repositório, troca de branch e detecta o comando de teste. Segredos usados (token) voltam em `secrets`.
	 * `track(secret)` registra o segredo NA HORA (antes do clone): se o clone falhar, a mensagem de erro já sai redigida.
	 */
	prepare?(session: CodeSession, client: DevClient, input: { repo?: string; branch?: string }, signal?: AbortSignal, track?: (secret: string) => void): Promise<{ repo?: string; branch?: string; testCommand?: string; note?: string; secrets?: string[] }>;
	/**
	 * Ambiente SÓ do job de git que fala com o GitHub (push, fetch, ls-remote): `GH_TOKEN`/`GITHUB_TOKEN` do dono, que o helper de
	 * credencial da imagem lê. Nunca vai a resultado, evento, log ou ao ambiente de um comando do modelo.
	 */
	gitEnv?(session: CodeSession): Promise<Record<string, string>>;
	/** Leitura do GitHub para PR e CI com o token do dono. Falha = `throw` com a mensagem real (já amigável, sem segredo). */
	github?: {
		/** PR aberto cuja branch de origem é `head`, ou `null`. */
		findOpenPull(session: CodeSession, repo: string, head: string): Promise<DevPrInfo | null>;
		/** PR + checks por número ou pela branch (PR aberto dela); `null` = não há PR da branch. */
		pull(session: CodeSession, repo: string, ref: { number: number } | { head: string }): Promise<{ pr: DevPrInfo; checks: DevCiCheck[]; summary: DevCiSummary } | null>;
		/** Log inteiro de um job do Actions (a fatia é feita aqui). */
		jobLog(session: CodeSession, repo: string, jobId: number): Promise<string>;
	};
	/** Segredos conhecidos da sessão (token do GitHub, variáveis do ambiente) para redigir saída e erro. */
	secrets?(session: CodeSession): Promise<readonly string[]> | readonly string[];
	/** Teto de espera de um comando (ms). Padrão 120 s; o pedido do modelo pode baixar, nunca passar de 600 s. */
	defaultTimeoutMs?: number;
	/** Pausa entre consultas ao job (ms). Injetável para teste. */
	pollMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const NOT_FOUND = "Coding session not found.";
/** Tudo abaixo disto fica inline; o resto da saída vai para um arquivo do workspace (`spillPath`) e o modelo lê em partes. */
const INLINE_OUTPUT_CHARS = 30_000;
/** Pasta de apoio do agente no workspace: fora de qualquer repositório e ignorada pelo git (ver `inlineOrSpill`). */
const SPILL_DIR = "/workspace/.atlas";

const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Teto, em caracteres, da saída de cada stream (stdout e stderr) guardada na memória do worker enquanto o job roda. Um comando
 * que imprime sem parar (até 600 s) não pode estourar a memória: passou disso, fica só a cauda, e o início sai contado.
 */
const STREAM_TAIL_CHARS = 1_000_000;

/** Cauda de um stream: guarda os últimos `limit` caracteres e conta em bytes o que saiu do início. */
class StreamTail {
	private text = "";
	private omittedBytes = 0;
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(chunk: string): void {
		this.text += chunk;
		const excess = this.text.length - this.limit;
		if (excess <= 0) return;
		this.omittedBytes += Buffer.byteLength(this.text.slice(0, excess));
		this.text = this.text.slice(excess);
	}

	render(): string {
		return this.omittedBytes > 0 ? `(${this.omittedBytes} bytes iniciais omitidos)\n${this.text}` : this.text;
	}
}

class Refused extends Error {}

/** Redige cada texto do resultado (não o JSON serializado: `\\nBearer` não tem fronteira de palavra e escaparia). */
function redactDeep<T>(value: T, secrets: readonly string[]): T {
	if (typeof value === "string") return redactSecrets(value, [...secrets]) as T;
	if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)])) as T;
	return value;
}

function pathError(path: string | undefined): string | null {
	if (path === undefined) return null;
	if (path.includes("\0")) return "invalid path";
	if (path.split(/[\\/]/).includes("..")) return 'path cannot contain ".."';
	if (path.startsWith("/") && path !== "/workspace" && !path.startsWith("/workspace/")) return "only paths inside /workspace are allowed";
	return null;
}

function parse<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
	const parsed = schema.safeParse(params);
	if (!parsed.success) throw new Refused(`Invalid parameters: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
	return parsed.data;
}

export function createCodeActionHandler(deps: CodeActionDeps): CodeActionHandler {
	async function sessionOf(userId: string, sessionId: string): Promise<CodeSession> {
		const session = await deps.sessions.get(sessionId, userId);
		if (!session || session.userId !== userId) throw new Refused(NOT_FOUND);
		return session;
	}

	async function runJob(client: DevClient, session: CodeSession, input: { cmd: string; cwd?: string; timeoutMs?: number; env?: Record<string, string> }, signal?: AbortSignal) {
		const timeoutMs = Math.min(input.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 600_000);
		const started = await client.execStart({ cmd: input.cmd, ...(input.cwd && { cwd: input.cwd }), ...(input.env && { env: input.env }), timeoutMs });
		const deadline = Date.now() + timeoutMs + 5_000;
		let snapshot: DevExecSnapshot;
		let out = 0;
		let err = 0;
		const stdout = new StreamTail(STREAM_TAIL_CHARS);
		const stderr = new StreamTail(STREAM_TAIL_CHARS);
		for (;;) {
			if (signal?.aborted) {
				await client.execKill(started.id, "SIGTERM").catch(() => undefined);
				throw new Refused("Cancelled.");
			}
			snapshot = await client.execPoll(started.id, { out, err, waitMs: deps.pollMs ?? 1_000 });
			stdout.push(snapshot.stdout);
			stderr.push(snapshot.stderr);
			out = snapshot.nextOut;
			err = snapshot.nextErr;
			if (!snapshot.running) break;
			if (Date.now() > deadline) {
				await client.execKill(started.id, "SIGKILL").catch(() => undefined);
				return { snapshot, output: `${stdout.render()}${stderr.render()}`, timedOut: true };
			}
		}
		void session;
		return { snapshot, output: `${stdout.render()}${stderr.render()}`, timedOut: snapshot.timedOut };
	}

	/**
	 * Saída longa: o corpo inteiro vai para um arquivo e o modelo lê o resto por `code.read`. Nada se perde em silêncio.
	 * O arquivo mora em `/workspace/.atlas/output/` com um `.gitignore` `*` (nunca entra em commit, mesmo que /workspace seja um
	 * repositório) e o texto é REDIGIDO ANTES de gravar: segredo que apareceu na saída não fica em disco.
	 */
	async function inlineOrSpill(client: DevClient, rawOutput: string, jobId: string, secrets: readonly string[]): Promise<{ output: string; spillPath?: string }> {
		const output = redactSecrets(rawOutput, [...secrets]);
		if (output.length <= INLINE_OUTPUT_CHARS) return { output };
		const spillPath = `${SPILL_DIR}/output/${jobId}.log`;
		await client.writeFile({ path: `${SPILL_DIR}/.gitignore`, content: "*\n" });
		await client.writeFile({ path: spillPath, content: output });
		return { output: `${output.slice(0, INLINE_OUTPUT_CHARS)}\n[… ${output.length - INLINE_OUTPUT_CHARS} more characters in ${spillPath}]`, spillPath };
	}

	/** A pasta do comando é a raiz de um workspace pnpm? (`pnpm test` ali roda todos os pacotes.) Só o adaptador enxerga a VM. */
	async function isWorkspaceRoot(client: DevClient, session: CodeSession, cwd: string | undefined): Promise<boolean> {
		const repo = session.repo ? `/workspace/${session.repo.split("/").pop()}` : "/workspace";
		for (const dir of cwd ? [cwd] : [repo, "/workspace"]) {
			try {
				const file = await client.readFile({ path: `${dir.endsWith("/") ? dir.slice(0, -1) : dir}/pnpm-workspace.yaml`, offset: 0, limit: 40 });
				if (file.kind === "text" && file.content.includes("packages")) return true;
			} catch {
				// sem o arquivo nessa pasta
			}
		}
		return false;
	}

	async function handle(userId: string, kind: CodeKind, raw: unknown, known: { secrets: readonly string[] }, signal?: AbortSignal): Promise<{ data: unknown; secrets: readonly string[] }> {
		if (kind === CODE_KINDS.session) {
			const p = parse(codeParams.session, raw);
			if (p.sessionId) {
				const session = await sessionOf(userId, p.sessionId);
				await deps.connect(session, signal);
				await deps.sessions.touch?.(session.id, userId);
				return { data: { sessionId: session.id, ...(session.repo && { repo: session.repo }), ...(session.branch && { branch: session.branch }), status: session.status }, secrets: await secretsOf(session) };
			}
			const session = await deps.sessions.create(userId, { ...(p.repo && { repo: p.repo }), ...(p.branch && { branch: p.branch }) });
			const client = await deps.connect(session, signal);
			const track = (secret: string) => {
				if (secret) known.secrets = [...known.secrets, secret];
			};
			const prepared = (await deps.prepare?.(session, client, { ...(p.repo && { repo: p.repo }), ...(p.branch && { branch: p.branch }) }, signal, track)) ?? {};
			return { data: { sessionId: session.id, ...((prepared.repo ?? p.repo) && { repo: prepared.repo ?? p.repo }), ...((prepared.branch ?? p.branch) && { branch: prepared.branch ?? p.branch }), status: "RUNNING", ...(prepared.testCommand && { testCommand: prepared.testCommand }), ...(prepared.note && { note: prepared.note }) }, secrets: prepared.secrets ?? [] };
		}

		const p = parse(codeParams[kindKey(kind)], raw) as { sessionId: string; path?: string; cmd?: string; cwd?: string };
		const bad = pathError(p.path) ?? pathError(p.cwd);
		if (bad) throw new Refused(`Refused: ${bad}.`);
		const session = await sessionOf(userId, p.sessionId);
		const secrets = await secretsOf(session);
		// O erro de uma chamada que falha depois daqui também sai redigido com os segredos desta sessão.
		known.secrets = secrets;
		const client = await deps.connect(session, signal);
		await deps.sessions.touch?.(session.id, userId);

		switch (kind) {
			case CODE_KINDS.list: {
				const q = p as z.output<typeof codeParams.list>;
				return { data: await client.list({ ...(q.path && { path: q.path }), ...(q.depth && { depth: q.depth }) }), secrets };
			}
			case CODE_KINDS.read: {
				const q = p as z.output<typeof codeParams.read>;
				const r = await client.readFile({ path: q.path, ...(q.offset !== undefined && { offset: q.offset }), ...(q.limit !== undefined && { limit: q.limit }) });
				return { data: { path: r.path, content: r.kind === "binary" ? "" : r.content, totalLines: r.totalLines, startLine: r.startLine, endLine: r.endLine, nextOffset: r.nextOffset, kind: r.kind, ...(r.note && { note: r.note }) }, secrets };
			}
			case CODE_KINDS.edit: {
				const q = p as z.output<typeof codeParams.edit>;
				const r = await client.patchFile({ path: q.path, old: q.old, new: q.new, ...(q.replaceAll && { replaceAll: true }) });
				return { data: { path: r.path, diff: r.diff, added: r.added, removed: r.removed, ...(r.note && { note: r.note }), ...(r.excerpt && { excerpt: r.excerpt }), ...(r.syntaxError && { syntaxError: r.syntaxError }) }, secrets };
			}
			case CODE_KINDS.write: {
				const q = p as z.output<typeof codeParams.write>;
				const r = await client.writeFile({ path: q.path, content: q.content });
				return { data: { path: r.path, created: r.created, bytes: r.bytes, diff: r.diff, added: r.added, removed: r.removed, ...(r.excerpt && { excerpt: r.excerpt }), ...(r.syntaxError && { syntaxError: r.syntaxError }) }, secrets };
			}
			case CODE_KINDS.shell:
			case CODE_KINDS.test: {
				const q = p as z.output<typeof codeParams.shell>;
				const cls = classifyShell(q.cmd);
				if (cls.kind === "deny") throw new Refused(`Refused: ${cls.reason}.`);
				// `pnpm test` na raiz de monorepo roda todos os pacotes: a capacidade não vê a VM, então a conferência é daqui.
				if (!(p as { fullSuite?: boolean }).fullSuite) {
					const whole = isFullSuiteTestCommand(q.cmd, { rootIsWorkspace: await isWorkspaceRoot(client, session, q.cwd) });
					if (whole) throw new Refused(fullSuiteAdvice(whole));
				}
				const { snapshot, output, timedOut } = await runJob(client, session, q, signal);
				const spilled = await inlineOrSpill(client, output, snapshot.id, secrets);
				return { data: { exitCode: snapshot.exitCode, output: spilled.output, ...(timedOut && { timedOut: true }), durationMs: snapshot.durationMs, ...(spilled.spillPath && { spillPath: spilled.spillPath }), cwd: snapshot.cwd }, secrets };
			}
			case CODE_KINDS.gitStatus: {
				const { snapshot, output } = await runJob(client, session, { cmd: "git status --porcelain=v1 --branch", cwd: repoDir(session) }, signal);
				if (snapshot.exitCode !== 0) throw new Refused(`git status failed: ${output.trim().slice(0, 500)}`);
				return { data: parseStatus(output), secrets };
			}
			case CODE_KINDS.diff: {
				const q = p as z.output<typeof codeParams.diff>;
				const cmd = `git --no-pager diff --no-color${q.staged ? " --cached" : ""}${q.path ? ` -- ${shq(q.path)}` : ""}`;
				const { snapshot, output } = await runJob(client, session, { cmd, cwd: repoDir(session) }, signal);
				if (snapshot.exitCode !== 0) throw new Refused(`git diff failed: ${output.trim().slice(0, 500)}`);
				const spilled = await inlineOrSpill(client, output, snapshot.id, secrets);
				return { data: { diff: spilled.output, empty: output.trim() === "", ...(spilled.spillPath && { spillPath: spilled.spillPath }) }, secrets };
			}
			case CODE_KINDS.commit:
				return { data: await commit(client, session, p as z.output<typeof codeParams.commit>, secrets, signal), secrets };
			case CODE_KINDS.push:
				return { data: await push(client, session, signal), secrets };
			case CODE_KINDS.prPrepare:
				return { data: await prPrepare(client, session, p as z.output<typeof codeParams.prPrepare>, signal), secrets };
			case CODE_KINDS.ci:
				return { data: await ci(client, session, p as z.output<typeof codeParams.ci>, signal), secrets };
			case CODE_KINDS.ciLog:
				return { data: await ciLog(session, p as z.output<typeof codeParams.ciLog>), secrets };
		}
		throw new Refused(`Unhandled ${kind}`);
	}

	// ----- entrega: commit, push, PR e CI (F9) -----

	/** Git local no repositório da sessão. `env` só entra se o job falar com o GitHub. */
	async function git(client: DevClient, session: CodeSession, script: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
		const { snapshot, output } = await runJob(client, session, { cmd: script, env: { DEV_REPO_DIR: repoDir(session), ...env }, timeoutMs }, signal);
		return { exitCode: snapshot.exitCode, output };
	}

	async function inspect(client: DevClient, session: CodeSession, signal?: AbortSignal): Promise<{ head: string; defaultBranch: string; dirty: number; sha: string }> {
		const r = await git(client, session, INSPECT_SCRIPT, {}, 30_000, signal);
		if (r.exitCode !== 0) throw new Refused(`Could not read the repository in the workspace: ${r.output.trim().slice(0, 300)}`);
		const v = parseKeyValues(r.output);
		return { head: v.head ?? "", defaultBranch: v.default ?? "", dirty: Number(v.dirty) || 0, sha: v.sha ?? "" };
	}

	function repoOf(session: CodeSession): string {
		if (!session.repo || !REPO_SLUG.test(session.repo)) throw new Refused("This session has no GitHub repository (owner/name). Open a session with a repo first.");
		return session.repo;
	}

	async function commit(client: DevClient, session: CodeSession, p: z.output<typeof codeParams.commit>, secrets: readonly string[], signal?: AbortSignal) {
		const state = await inspect(client, session, signal);
		if (p.branch) {
			if (!isSafeGitRef(p.branch)) throw new Refused("Refused: unsupported branch name.");
			if (isProtectedBranch(p.branch, state.defaultBranch)) throw new Refused(`Refused: ${p.branch} is the default branch. Pick a new branch name for the change.`);
		} else if (!state.head || isProtectedBranch(state.head, state.defaultBranch)) {
			throw new Refused(`Refused: the workspace is ${state.head ? `on the default branch (${state.head})` : "not on a branch"}. Pass \`branch\` with a new branch name to commit the change there.`);
		}
		const staged = await git(client, session, STAGE_SCRIPT, { DEV_BRANCH: p.branch ?? "", DEV_PATHS: (p.paths ?? []).join("\n") }, 60_000, signal);
		if (staged.exitCode === 13) throw new Refused(`Could not create the branch ${p.branch} (it may already exist). Pick another name.`);
		if (staged.exitCode !== 0) throw new Refused(`Could not stage the changes: ${staged.output.trim().slice(0, 400)}`);
		const names = staged.output.split("\n").map((line) => line.trim()).filter(Boolean);
		if (names.length === 0) throw new Refused("Nothing to commit: there are no changes in the workspace.");
		const secretFiles = names.filter((name) => isSensitiveEnvFile(name));
		if (secretFiles.length > 0) {
			await git(client, session, 'cd "$DEV_REPO_DIR" && git reset -q', {}, 30_000, signal);
			throw new Refused(`Refused: secret files would be committed (${secretFiles.slice(0, 5).join(", ")}). Nothing was committed and the stage was undone. Add them to .gitignore or commit only the right files with paths.`);
		}
		const message = redactSecrets(p.message, [...secrets]);
		const done = await git(client, session, COMMIT_SCRIPT, { DEV_MSG: message }, 120_000, signal);
		if (done.exitCode !== 0) throw new Refused(`git commit failed: ${done.output.trim().slice(0, 600)}`);
		const v = parseKeyValues(done.output);
		return { sha: v.sha ?? "", branch: v.branch ?? p.branch ?? state.head, subject: v.subject ?? message.split("\n")[0] ?? "", files: names.length, ...(p.branch && { createdBranch: true }) };
	}

	async function push(client: DevClient, session: CodeSession, signal?: AbortSignal) {
		const repo = repoOf(session);
		const state = await inspect(client, session, signal);
		const refusal = pushRefusal(state.head, state.defaultBranch);
		if (refusal) throw new Refused(refusal);
		const env = (await deps.gitEnv?.(session)) ?? {};
		// Refspec explícito sem `+`: nunca força, e só a branch atual vai (o modelo não escolhe o destino).
		const r = await git(client, session, PUSH_SCRIPT, { ...env, DEV_HEAD: state.head }, 300_000, signal);
		if (r.exitCode !== 0) {
			const tail = r.output.trim().slice(-800);
			const hint = ["rejected", "non-fast-forward", "fetch first"].some((word) => r.output.includes(word)) ? " The remote branch has commits the workspace does not have; do not force. Tell the owner and pick a new branch name." : ["Authentication", "denied", "403", "could not read Username"].some((word) => r.output.includes(word)) ? " GitHub refused the credentials: tell the owner to check the GitHub connection (Connections) and the repository access." : "";
			throw new Refused(`git push failed (exit ${r.exitCode}): ${tail}${hint}`);
		}
		return { branch: state.head, repo, ...(state.sha && { sha: state.sha }), newBranch: r.output.includes("[new branch]"), url: `https://github.com/${repo}/tree/${state.head}` };
	}

	async function prPrepare(client: DevClient, session: CodeSession, p: z.output<typeof codeParams.prPrepare>, signal?: AbortSignal) {
		const repo = repoOf(session);
		if (p.base && !isSafeGitRef(p.base)) throw new Refused("Refused: unsupported base branch name.");
		const env = (await deps.gitEnv?.(session)) ?? {};
		const r = await git(client, session, PR_SCRIPT, { ...env, DEV_BASE: p.base ?? "" }, 120_000, signal);
		if (r.exitCode !== 0) throw new Refused(`Could not read the repository in the workspace: ${r.output.trim().slice(0, 300)}`);
		const v = parseKeyValues(r.output);
		const head = v.head ?? "";
		if (!head) throw new Refused("The workspace is not on a branch (detached HEAD). Create one with code_commit (branch) first.");
		const base = v.base || "main";
		const sha = v.sha ?? "";
		let existingPr: { number: number; url: string; state: string; title: string } | undefined;
		if (deps.github && head !== base) {
			const found = await deps.github.findOpenPull(session, repo, head).catch(() => null);
			if (found) existingPr = { number: found.number, url: found.url, state: found.state, title: found.title };
		}
		return { repo, head, base, ahead: Number(v.ahead) || 0, files: Number(v.files) || 0, dirty: Number(v.dirty) || 0, pushed: Boolean(v.remote) && v.remote === sha, ...(existingPr && { existingPr }) };
	}

	async function ci(client: DevClient, session: CodeSession, p: z.output<typeof codeParams.ci>, signal?: AbortSignal) {
		const repo = repoOf(session);
		if (!deps.github) throw new Refused("Reading the CI is not available here.");
		let ref: { number: number } | { head: string };
		if (p.number !== undefined) ref = { number: p.number };
		else {
			const state = await inspect(client, session, signal);
			if (!state.head) throw new Refused("The workspace is not on a branch; pass the pull request number.");
			ref = { head: state.head };
		}
		const found = await deps.github.pull(session, repo, ref);
		if (!found) return { repo, pr: null, summary: "none" as const, checks: [], note: "Push the branch (code_push) and open one first." };
		const { pr, checks, summary } = found;
		return {
			repo,
			pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title, base: pr.base, head: pr.head },
			summary,
			checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, ...(c.url && { url: c.url }), ...(c.durationMs !== undefined && { durationMs: c.durationMs }), ...(c.jobId && { jobId: c.jobId }) })),
		};
	}

	/** Log de um job em PARTES: sem `offset` devolve o fim (onde a falha costuma estar) e diz onde está a parte anterior. */
	async function ciLog(session: CodeSession, p: z.output<typeof codeParams.ciLog>) {
		const repo = repoOf(session);
		if (!deps.github) throw new Refused("Reading the CI is not available here.");
		const text = cleanJobLog(await deps.github.jobLog(session, repo, p.jobId));
		const limit = p.limit ?? 6_000;
		const total = text.length;
		let start = p.offset ?? Math.max(0, total - limit);
		if (p.offset === undefined && start > 0) {
			const nl = text.indexOf("\n", start);
			if (nl !== -1 && nl < total - 1) start = nl + 1;
		}
		start = Math.min(start, total);
		const end = Math.min(total, start + limit);
		const errors = p.offset === undefined ? jobLogErrors(text) : [];
		return { jobId: p.jobId, text: text.slice(start, end), startOffset: start, endOffset: end, totalChars: total, previousOffset: start > 0 ? Math.max(0, start - limit) : null, nextOffset: end < total ? end : null, ...(errors.length > 0 && { errors }) };
	}

	async function secretsOf(session: CodeSession): Promise<readonly string[]> {
		return (await deps.secrets?.(session)) ?? [];
	}

	return {
		handles: isCodeKind as CodeActionHandler["handles"],
		async run(userId, action, signal) {
			if (!isCodeKind(action.kind)) return { ok: false, error: `Unknown code action ${action.kind}.` };
			const known = { secrets: [] as readonly string[] };
			try {
				const out = await handle(userId, action.kind, action.params, known, signal);
				known.secrets = out.secrets;
				const key = kindKey(action.kind);
				const data = codeResults[key].parse(out.data);
				return { ok: true, data: redactDeep(data, known.secrets) };
			} catch (error) {
				// Erro da VM (409 de edição ambígua, 404 de arquivo) é mensagem útil ao modelo; vai redigido.
				const message = error instanceof Refused || error instanceof DevSandboxError ? error.message : error instanceof Error ? error.message : String(error);
				return { ok: false, error: redactSecrets(message, [...known.secrets]).slice(0, 1_500) };
			}
		},
	};
}

type ParamKey = keyof typeof codeParams;
const KEY_OF = new Map<CodeKind, ParamKey>([
	[CODE_KINDS.session, "session"],
	[CODE_KINDS.list, "list"],
	[CODE_KINDS.read, "read"],
	[CODE_KINDS.edit, "edit"],
	[CODE_KINDS.write, "write"],
	[CODE_KINDS.shell, "shell"],
	[CODE_KINDS.test, "test"],
	[CODE_KINDS.gitStatus, "gitStatus"],
	[CODE_KINDS.diff, "diff"],
	[CODE_KINDS.commit, "commit"],
	[CODE_KINDS.push, "push"],
	[CODE_KINDS.prPrepare, "prPrepare"],
	[CODE_KINDS.ci, "ci"],
	[CODE_KINDS.ciLog, "ciLog"],
]);
function kindKey(kind: CodeKind): ParamKey {
	const key = KEY_OF.get(kind);
	if (!key) throw new Refused(`Unknown code action ${kind}.`);
	return key;
}

const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Branches em que o agente nunca comita nem envia: a padrão do repositório (lida do `origin/HEAD`) e as duas convenções. */
const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];
export const isProtectedBranch = (branch: string, defaultBranch: string): boolean => branch === defaultBranch || PROTECTED_BRANCHES.includes(branch);

/** Motivo de recusar o push da branch atual, ou `null`. Puro: o mesmo teste vale para qualquer VM. */
export function pushRefusal(head: string, defaultBranch: string): string | null {
	if (!head) return "Refused: the workspace is not on a branch (detached HEAD). Create one with code_commit (branch) first.";
	if (!isSafeGitRef(head)) return "Refused: unsupported branch name.";
	if (isProtectedBranch(head, defaultBranch)) return `Refused: ${head} is the default branch and is never pushed from here. Commit on a new branch (code_commit with branch) and push that one.`;
	return null;
}

function parseKeyValues(output: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const match = /^([a-z]+)=(.*)$/.exec(line.trim());
		if (match) values[match[1]!] = match[2]!;
	}
	return values;
}

// Scripts do git (rodam no ambiente da sessão; dado variável entra por `env`, nunca colado no texto do comando).
const INSPECT_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 11',
	'echo "head=$(git symbolic-ref --short -q HEAD)"',
	`echo "default=$(git symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"`,
	'echo "dirty=$(git status --porcelain | wc -l)"',
	'echo "sha=$(git rev-parse HEAD 2>/dev/null)"',
].join("\n");
const STAGE_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 11',
	'if [ -n "$DEV_BRANCH" ]; then git switch -c "$DEV_BRANCH" >/dev/null 2>&1 || exit 13; fi',
	'if [ -n "$DEV_PATHS" ]; then',
	"\tset -f; IFS='",
	"'; for p in $DEV_PATHS; do git add -A -- \"$p\" || exit 14; done",
	"else git add -A || exit 14; fi",
	"git diff --cached --name-only",
].join("\n");
const COMMIT_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 11',
	'git commit -q -m "$DEV_MSG" || exit 15',
	'echo "sha=$(git rev-parse HEAD)"',
	'echo "branch=$(git symbolic-ref --short -q HEAD)"',
	'echo "subject=$(git log -1 --format=%s)"',
].join("\n");
const PUSH_SCRIPT = ['cd "$DEV_REPO_DIR" || exit 11', 'git push -u origin "refs/heads/$DEV_HEAD:refs/heads/$DEV_HEAD" 2>&1'].join("\n");
const PR_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 11',
	'head=$(git symbolic-ref --short -q HEAD)',
	'echo "head=$head"',
	'base="$DEV_BASE"',
	`if [ -z "$base" ]; then base=$(git symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||'); fi`,
	'[ -z "$base" ] && base=main',
	'echo "base=$base"',
	'git fetch origin "$base" >/dev/null 2>&1 || echo "fetch=failed"',
	'echo "dirty=$(git status --porcelain | wc -l)"',
	'echo "ahead=$(git rev-list --count "origin/$base..HEAD" 2>/dev/null || echo -1)"',
	'echo "files=$(git diff --name-only "origin/$base...HEAD" 2>/dev/null | wc -l)"',
	'echo "sha=$(git rev-parse HEAD 2>/dev/null)"',
	'[ -n "$head" ] && echo "remote=$(git ls-remote --heads origin "$head" 2>/dev/null | cut -f1)"',
].join("\n");

/** Pasta do repositório da sessão: `/workspace/<nome>` quando há repo, senão a raiz. */
function repoDir(session: CodeSession): string {
	const name = session.repo?.split("/").pop();
	return name ? `/workspace/${name}` : "/workspace";
}

/** `git status --porcelain=v1 --branch` → branch e arquivos. Puro, exportado para teste. */
export function parseStatus(output: string): { branch: string | null; files: Array<{ status: string; path: string }>; clean: boolean } {
	let branch: string | null = null;
	const files: Array<{ status: string; path: string }> = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		if (line.startsWith("## ")) {
			const head = line.slice(3).split("...")[0] ?? "";
			branch = head.startsWith("HEAD (no branch)") ? null : head.replace(/^No commits yet on /, "");
			continue;
		}
		files.push({ status: line.slice(0, 2).trim() || "?", path: line.slice(3) });
	}
	return { branch, files, clean: files.length === 0 };
}

export { CODE_KIND_LIST };
