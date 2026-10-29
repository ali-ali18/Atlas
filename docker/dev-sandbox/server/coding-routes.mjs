import { createExecManager } from "./exec-jobs.mjs";
import { createFileApi } from "./files.mjs";
import { createGrepApi } from "./grep.mjs";
import { createJobCallback } from "./job-callback.mjs";
import { createEgressPolicy } from "./egress-proxy.mjs";

// Rotas de "mãos de programador": exec (shell), arquivos e grep. A autenticação
// (bearer por container) é feita em server.mjs; a contenção aqui é o usuário
// não-root `dev` + confinamento de caminhos da API de arquivos.
// Nunca logamos cmd/env/conteúdo: podem carregar segredos (ex.: GH_TOKEN).

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			const error = new Error("corpo grande demais");
			error.status = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		const error = new Error("JSON inválido");
		error.status = 400;
		throw error;
	}
}

function sandboxIdentity() {
	const uid = Number.parseInt(process.env.DEV_USER_UID ?? "1000", 10);
	const gid = Number.parseInt(process.env.DEV_USER_GID ?? "1000", 10);
	// Só troca de usuário quando o control roda como root (imagem); em dev local segue o usuário atual.
	return typeof process.getuid === "function" && process.getuid() === 0 ? { uid, gid } : {};
}

export function createCodingRoutes(options = {}) {
	const identity = options.identity ?? sandboxIdentity();
	const egress = options.egress ?? createEgressPolicy({ mode: process.env.DEV_EGRESS_MODE, allowlist: (process.env.DEV_EGRESS_ALLOWLIST ?? "").split(",") });
	const notify = options.notify ?? createJobCallback({ url: process.env.DEV_SANDBOX_CALLBACK_URL, token: process.env.DEV_SANDBOX_TOKEN, sessionId: process.env.DEV_SANDBOX_SESSION_ID });
	const exec = options.exec ?? createExecManager({ identity, extraEnv: () => egress.env(), onEnd: notify ?? undefined });
	const files = options.files ?? createFileApi({ identity });
	const grep = options.grep ?? createGrepApi();

	/** Devolve true se tratou a requisição. */
	const handleCoding = async function handleCoding(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = req.method ?? "GET";
		const isExec = path === "/exec" || path.startsWith("/exec/");
		const isFiles = path === "/files" || path.startsWith("/files/");
		const isGrep = path === "/grep";
		const isEgress = path === "/egress";
		if (!isExec && !isFiles && !isGrep && !isEgress) return false;

		try {
			if (isEgress) {
				if (method === "GET") sendJson(res, 200, egress.get());
				else if (method === "PUT") sendJson(res, 200, egress.set(await readBody(req)));
				else sendJson(res, 405, { error: "método não permitido" });
				return true;
			}
			if (method === "POST" && path === "/exec") {
				const body = await readBody(req);
				if (body.background === true) {
					if (body.dedupe === true) {
						const existing = await exec.findRunning(body);
						if (existing) {
							sendJson(res, 200, { id: existing.id, deduped: true, durationMs: Date.now() - existing.startedAt });
							return true;
						}
					}
					const job = await exec.start(body, { background: true });
					sendJson(res, 200, { id: job.id, cwd: job.cwd });
					return true;
				}
				const controller = new AbortController();
				res.once("close", () => {
					if (!res.writableEnded) controller.abort();
				});
				const result = await exec.run(body, { signal: controller.signal });
				sendJson(res, 200, result);
				return true;
			}

			const execMatch = /^\/exec\/([a-f0-9]{12})(?:\/(stdin|kill))?$/.exec(path);
			if (execMatch) {
				const id = execMatch[1];
				const action = execMatch[2];
				if (method === "GET" && !action) {
					const q = url.searchParams;
					sendJson(res, 200, await exec.poll(id, { out: Number(q.get("out") ?? 0) || 0, err: Number(q.get("err") ?? 0) || 0, waitMs: Number(q.get("waitMs") ?? 0) || 0, until: q.get("until") ?? undefined }));
					return true;
				}
				if (method === "POST" && action === "stdin") {
					sendJson(res, 200, exec.stdin(id, await readBody(req)));
					return true;
				}
				if (method === "POST" && action === "kill") {
					const body = await readBody(req);
					sendJson(res, 200, exec.kill(id, body.signal));
					return true;
				}
			}

			if (method === "POST" && path === "/grep") {
				sendJson(res, 200, await grep.search(await readBody(req)));
				return true;
			}
			if (method === "GET" && path === "/files") {
				const q = url.searchParams;
				sendJson(res, 200, await files.read({ path: q.get("path"), offset: q.get("offset"), limit: q.get("limit") }));
				return true;
			}
			if (method === "PUT" && path === "/files") {
				sendJson(res, 200, await files.write(await readBody(req)));
				return true;
			}
			if (method === "POST" && path === "/files/patch") {
				sendJson(res, 200, await files.patch(await readBody(req)));
				return true;
			}
			if (method === "GET" && path === "/files/list") {
				const q = url.searchParams;
				sendJson(res, 200, await files.list({ path: q.get("path") ?? undefined, depth: q.get("depth") }));
				return true;
			}
			sendJson(res, 404, { error: "not found" });
			return true;
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			sendJson(res, status, { error: error instanceof Error ? error.message : "erro" });
			return true;
		}
	};
	handleCoding.exec = exec;
	handleCoding.egress = egress;
	return handleCoding;
}
