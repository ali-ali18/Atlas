// Montagem de produção das dependências de `code-actions.ts` (F8.2): sessão no banco (`dev_sessions`, sempre por `{ id, userId }`),
// ambiente pelo provedor Docker de `@workspace/sandbox` e clone com o token do GitHub do dono. Separado de `code-actions.ts` para o
// tratador por kind ser testado sem banco. O integrador chama `realCodeActionDeps({ provider, getGithubToken, conversationId })`.
import { createDevSession, getDevSession, updateDevSession, type DevSessionRecord } from "@workspace/db";
import { getGithubToken } from "@workspace/agent-runtime";
import { createDevClient, createDockerDevProvider, DevSandboxError, loadDevSandboxConfig, type DevClient, type DevSandboxProvider } from "@workspace/sandbox";
import { createCodeActionHandler, type CodeActionDeps, type CodeActionHandler, type CodeSession } from "./code-actions.js";

export type GithubTokenResult = { token: string } | { error: string };

const SLUG = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const toSession = (r: DevSessionRecord): CodeSession => ({ id: r.id, userId: r.userId, repo: r.repo, branch: r.branch, status: r.status });

export function realCodeActionDeps(input: { provider: DevSandboxProvider; getGithubToken: (userId: string, repo?: string) => Promise<GithubTokenResult>; conversationId?: string | null }): CodeActionDeps {
	const tokens = new Map<string, string>();
	return {
		sessions: {
			get: async (id, userId) => {
				const row = await getDevSession(id, userId);
				return row && row.userId === userId ? toSession(row) : null;
			},
			create: async (userId, args) => {
				if (args.repo && !SLUG.test(args.repo)) throw new Error("Invalid repository: use owner/name.");
				if (args.branch && !BRANCH.test(args.branch)) throw new Error("Invalid branch name.");
				return toSession(await createDevSession({ userId, conversationId: input.conversationId ?? null, repo: args.repo ?? null, branch: args.branch ?? null, status: "CREATING" }));
			},
			touch: async (id) => updateDevSession(id, { touch: true }),
		},
		connect: async (session, signal): Promise<DevClient> => {
			const result = await input.provider.ensureRunning({ sessionId: session.id, userId: session.userId, tier: "small", ...(session.repo && { envCacheRepo: session.repo }) });
			if (result.status === "queued") {
				await updateDevSession(session.id, { status: "QUEUED" });
				throw new Error(`The code environment is busy right now (${result.denied.message}). Try again in a few minutes.`);
			}
			if (session.status !== "RUNNING") await updateDevSession(session.id, { status: "RUNNING", containerId: result.containerId, lastError: null, touch: true });
			return createDevClient(result.endpoint, signal ? { signal } : {});
		},
		prepare: async (session, client, args, _signal, track) => {
			const notes: string[] = [];
			const secrets: string[] = [];
			if (!args.repo) return { note: "Empty workspace (no repository given)." };
			const slug = SLUG.exec(args.repo);
			if (!slug) throw new Error("Invalid repository: use owner/name.");
			const name = slug[2]!.replace(/\.git$/, "");
			const token = await input.getGithubToken(session.userId, args.repo);
			if ("token" in token) {
				tokens.set(session.id, token.token);
				secrets.push(token.token);
				track?.(token.token); // antes do clone: se ele falhar, o erro já sai redigido
			}
			const env = { DEV_REPO_URL: `https://github.com/${args.repo}.git`, DEV_REPO_DIR: `/workspace/${name}`, ...("token" in token && { GH_TOKEN: token.token, GITHUB_TOKEN: token.token }) };
			const job = await client.execStart({ cmd: 'if [ -d "$DEV_REPO_DIR/.git" ]; then git -C "$DEV_REPO_DIR" fetch --all --prune; else git clone "$DEV_REPO_URL" "$DEV_REPO_DIR"; fi', env, timeoutMs: 300_000 });
			const done = await client.execPoll(job.id, { waitMs: 300_000, until: "exit" });
			if (done.exitCode !== 0) {
				const hint = "error" in token ? ` ${token.error}.` : "";
				throw new Error(`Could not clone ${args.repo}: ${(done.stdout + done.stderr).trim().slice(0, 400)}${hint}`);
			}
			if (args.branch) {
				const sw = await client.execStart({ cmd: 'cd "$DEV_REPO_DIR" && git checkout -B "$DEV_BRANCH"', env: { ...env, DEV_BRANCH: args.branch }, timeoutMs: 60_000 });
				const out = await client.execPoll(sw.id, { waitMs: 60_000, until: "exit" });
				if (out.exitCode !== 0) notes.push(`Could not switch to branch ${args.branch}.`);
			}
			await updateDevSession(session.id, { repo: args.repo, ...(args.branch && { branch: args.branch }), status: "RUNNING", touch: true });
			const testCommand = await detectTestCommand(client, `/workspace/${name}`);
			return { repo: args.repo, ...(args.branch && { branch: args.branch }), ...(testCommand && { testCommand }), ...(notes.length > 0 && { note: notes.join(" ") }), secrets };
		},
		// Durável: o Map é só cache. Outra instância do worker (ou depois de reiniciar) refaz o token do dono para a sessão, em vez
		// de redigir só o que esta instância viu.
		secrets: async (session) => {
			const cached = tokens.get(session.id);
			if (cached) return [cached];
			if (!session.repo) return [];
			const result = await input.getGithubToken(session.userId, session.repo).catch(() => ({ error: "unavailable" }) as GithubTokenResult);
			if (!("token" in result)) return [];
			tokens.set(session.id, result.token);
			return [result.token];
		},
	};
}

/** `scripts.test` do package.json do repositório: o comando de teste rápido que a sessão sugere ao modelo. */
async function detectTestCommand(client: DevClient, dir: string): Promise<string | undefined> {
	try {
		const file = await client.readFile({ path: `${dir}/package.json`, limit: 400 });
		const scripts = (JSON.parse(file.content) as { scripts?: Record<string, unknown> }).scripts;
		if (typeof scripts?.test !== "string") return undefined;
		const tree = await client.list({ path: dir, depth: 1 });
		return tree.entries.some((entry) => entry.path === "pnpm-lock.yaml") ? "pnpm test" : "npm test";
	} catch (error) {
		if (error instanceof DevSandboxError || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

let cachedProvider: { key: string; provider: DevSandboxProvider | null } | undefined;

/** Provedor Docker do ambiente de código, ou `null` com `DEV_SANDBOX_ENABLED` desligado. Um por processo (o config vem do ambiente). */
function devProvider(env: NodeJS.ProcessEnv): DevSandboxProvider | null {
	const config = loadDevSandboxConfig(env);
	const key = JSON.stringify([config.enabled, config.connectMode]);
	if (cachedProvider?.key !== key) cachedProvider = { key, provider: config.enabled ? createDockerDevProvider(config) : null };
	return cachedProvider.provider;
}

/**
 * Tratador de `code.*` de produção para a conversa do run, ou `null` com o ambiente de código desligado. A sessão de código é do
 * dono (`{ id, userId }`) e nasce amarrada à conversa; o token do GitHub é o da instalação que cobre o repo, ou o pessoal.
 */
export function realCodeActionHandler(input: { conversationId: string | null; env?: NodeJS.ProcessEnv; provider?: DevSandboxProvider | null }): CodeActionHandler | null {
	const provider = input.provider !== undefined ? input.provider : devProvider(input.env ?? process.env);
	if (!provider) return null;
	return createCodeActionHandler(
		realCodeActionDeps({
			provider,
			conversationId: input.conversationId,
			getGithubToken: async (userId, repo) => {
				const result = await getGithubToken(userId, repo ? { repo } : {});
				return "token" in result ? { token: result.token } : { error: result.error };
			},
		}),
	);
}
