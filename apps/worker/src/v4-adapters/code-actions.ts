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
import { fullSuiteAdvice, isFullSuiteTestCommand, redactSecrets } from "@workspace/shared";
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

	async function runJob(client: DevClient, session: CodeSession, input: { cmd: string; cwd?: string; timeoutMs?: number }, signal?: AbortSignal) {
		const timeoutMs = Math.min(input.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 600_000);
		const started = await client.execStart({ cmd: input.cmd, ...(input.cwd && { cwd: input.cwd }), timeoutMs });
		const deadline = Date.now() + timeoutMs + 5_000;
		let snapshot: DevExecSnapshot;
		let out = 0;
		let err = 0;
		let stdout = "";
		let stderr = "";
		for (;;) {
			if (signal?.aborted) {
				await client.execKill(started.id, "SIGTERM").catch(() => undefined);
				throw new Refused("Cancelled.");
			}
			snapshot = await client.execPoll(started.id, { out, err, waitMs: deps.pollMs ?? 1_000 });
			stdout += snapshot.stdout;
			stderr += snapshot.stderr;
			out = snapshot.nextOut;
			err = snapshot.nextErr;
			if (!snapshot.running) break;
			if (Date.now() > deadline) {
				await client.execKill(started.id, "SIGKILL").catch(() => undefined);
				return { snapshot, output: `${stdout}${stderr}`, timedOut: true };
			}
		}
		void session;
		return { snapshot, output: `${stdout}${stderr}`, timedOut: snapshot.timedOut };
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
		}
		throw new Refused(`Unhandled ${kind}`);
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
]);
function kindKey(kind: CodeKind): ParamKey {
	const key = KEY_OF.get(kind);
	if (!key) throw new Refused(`Unknown code action ${kind}.`);
	return key;
}

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
