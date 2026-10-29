import { spawn } from "node:child_process";
import { appendFileSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createOutputBuffer, RETURN_CAP_BYTES } from "./output-buffer.mjs";
import { confinePath, WORKSPACE, SANDBOX_HOME } from "./path-guard.mjs";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const MAX_CMD_CHARS = 100_000;
// Primeiro plano que passa de `autoBackgroundMs` vira job em segundo plano (não é morto).
export const DEFAULT_AUTO_BACKGROUND_MS = 30_000;
export const MAX_AUTO_BACKGROUND_MS = 600_000;
export const MAX_POLL_WAIT_MS = 30_000;
const MAX_UNTIL_CHARS = 300;
// Saída grande: a partir daqui o job também grava tudo em /workspace/.agent/output/<job>.txt (o agente mostra só head+tail inline).
export const SPILL_THRESHOLD_BYTES = 30_000;
export const SPILL_MAX_BYTES = 64 * 1024 * 1024;
export const SPILL_MAX_AGE_MS = 7 * 24 * 3_600_000;
const SPILL_REL_DIR = join(".agent", "output");
// Estado do shell entre chamadas (cwd + variáveis exportadas), por workspace/sessão.
const STATE_REL_DIR = join(".agent", "shell-state");
const UNTIL_WINDOW_BYTES = 256 * 1024;
const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_JOBS = 64;
const KILL_GRACE_MS = 3_000;

// Variáveis que mudariam o carregamento de código do processo do agente.
const BLOCKED_ENV = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "NODE_OPTIONS"]);
// Falhar rápido em vez de pendurar: rede lenta/bloqueada derruba o install em ~minutos, não em 30 min.
export const NETWORK_DEFAULTS = {
	npm_config_fetch_timeout: "60000",
	npm_config_fetch_retries: "2",
	npm_config_fetch_retry_mintimeout: "2000",
	npm_config_fetch_retry_maxtimeout: "20000",
	npm_config_network_concurrency: "8",
	npm_config_progress: "false",
	COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

export class ExecError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "ExecError";
		this.status = status;
	}
}

/**
 * Condição de `until`: `/padrão/flags` vira regex; qualquer outra coisa é busca de substring.
 * Devolve uma função texto => boolean (ou null sem condição).
 */
export function compileUntil(until) {
	if (typeof until !== "string" || !until) return null;
	if (until.length > MAX_UNTIL_CHARS) throw new ExecError("until grande demais");
	const last = until.lastIndexOf("/");
	if (until.startsWith("/") && last > 0) {
		const flags = until.slice(last + 1);
		if (/^[gimsuy]*$/.test(flags)) {
			try {
				const re = new RegExp(until.slice(1, last), flags.replace("g", "").replace("y", ""));
				return (text) => re.test(text);
			} catch {
				throw new ExecError("until: regex inválida");
			}
		}
	}
	return (text) => text.includes(until);
}

export function clampTimeout(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

/** Valida o env do pedido e separa os valores sensíveis (para redigir da saída). */
export function sanitizeEnv(input) {
	const env = {};
	const secrets = [];
	if (input === undefined || input === null) return { env, secrets };
	if (typeof input !== "object" || Array.isArray(input)) throw new ExecError("env deve ser um objeto");
	for (const [key, value] of Object.entries(input)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new ExecError(`nome de variável inválido: ${key}`);
		if (BLOCKED_ENV.has(key.toUpperCase())) throw new ExecError(`variável não permitida: ${key}`);
		if (typeof value !== "string" || value.length > 16_384) throw new ExecError(`valor inválido para ${key}`);
		env[key] = value;
		if (SECRET_KEY.test(key) && value.length >= 6) secrets.push(value);
	}
	return { env, secrets };
}

/** Comando sem diferenças de espaço/quebra de linha e sem `;`/`&&` finais (relançamento idêntico). */
export function normalizeCmd(cmd) {
	let out = "";
	let pendingSpace = false;
	for (const ch of String(cmd).trim()) {
		if (ch <= " ") {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingSpace) out += " ";
		pendingSpace = false;
		out += ch;
	}
	while (out.endsWith(";") || out.endsWith(" ") || out.endsWith("&&")) out = out.endsWith("&&") ? out.slice(0, -2) : out.slice(0, -1);
	return out;
}

export function redact(text, secrets) {
	let out = text;
	for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("***");
	return out;
}

/** Caches compartilhados (volume por usuário montado em /cache) repassados ao shell do agente. */
function cacheEnv() {
	const out = {};
	for (const key of ["PNPM_HOME", "PNPM_STORE_DIR", "npm_config_cache", "PIP_CACHE_DIR", "XDG_CACHE_HOME", "COREPACK_HOME", "CARGO_HOME", "UV_CACHE_DIR", "GOMODCACHE", "YARN_CACHE_FOLDER", "BUN_INSTALL_CACHE_DIR", "DEV_IMAGE_VERSION"]) {
		if (process.env[key]) out[key] = process.env[key];
	}
	return out;
}

/**
 * Prefixo do `bash -lc`: carrega as variáveis salvas e, no primeiro plano, grava cwd e variáveis
 * exportadas ao sair (trap EXIT preserva o código de saída). Só grava o que o comando mudou em relação
 * ao ambiente com que o shell nasceu, então o que o servidor injeta por comando (ex.: GH_TOKEN) não
 * vira estado; nomes com cara de segredo nunca são gravados, mesmo exportados pelo próprio comando.
 */
export function shellStatePrefix({ dir, id, save }) {
	const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
	const lines = [`__a_dir=${q(dir)}; __a_id=${q(id)}`];
	if (save) lines.push("declare -A __a_p; for __a_n in $(compgen -e); do __a_p[$__a_n]=${!__a_n}; done");
	lines.push('[ -f "$__a_dir/env" ] && . "$__a_dir/env" 2>/dev/null');
	if (save) {
		lines.push(
			"__a_save() {",
			"  shopt -s nocasematch",
			'  printf "%s\\n" "$PWD" > "$__a_dir/cwd.$__a_id" 2>/dev/null || return 0',
			"  { for __a_n in $(compgen -e); do",
			"      case $__a_n in PWD|OLDPWD|SHLVL|_|PPID|BASH_*|BASHOPTS|SHELLOPTS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|ENV|NODE_OPTIONS|__a_*) continue;; esac",
			"      [[ $__a_n =~ (TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL) ]] && continue",
			'      [[ ${__a_p[$__a_n]+x} && ${__a_p[$__a_n]} == "${!__a_n}" ]] && continue',
			"      printf 'export %s=%q\\n' \"$__a_n\" \"${!__a_n}\"",
			'    done; } > "$__a_dir/env.$__a_id" 2>/dev/null',
			"}",
			"trap __a_save EXIT",
		);
	}
	return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
}

export function createExecManager(options = {}) {
	const spawnFn = options.spawn ?? spawn;
	const now = options.now ?? Date.now;
	const workspace = options.workspace ?? WORKSPACE;
	const home = options.home ?? SANDBOX_HOME;
	const confine = options.confine ?? ((p) => confinePath(p, { base: workspace }));
	const identity = options.identity ?? {};
	const bufferBytes = options.bufferBytes ?? 1024 * 1024;
	const jobs = new Map();
	const spillDir = options.spillDir ?? join(workspace, SPILL_REL_DIR);
	const spillRoot = join(spillDir, "..");
	let spillReady = false;
	const stateDir = options.stateDir ?? join(workspace, STATE_REL_DIR);
	let stateReady;

	/** Apaga arquivos de saída com mais de 7 dias (ao criar o gerenciador, i.e. no início da sessão/container). */
	function purgeSpill() {
		try {
			const t = Date.now();
			for (const name of readdirSync(spillDir)) {
				const file = join(spillDir, name);
				try {
					if (t - statSync(file).mtimeMs > SPILL_MAX_AGE_MS) unlinkSync(file);
				} catch {
					// já sumiu
				}
			}
		} catch {
			// diretório ainda não existe
		}
	}

	/** Garante .agent/ em .git/info/exclude (nunca mexe no .gitignore do repositório). */
	function ensureGitExclude() {
		const info = join(workspace, ".git", "info");
		if (existsSync(join(workspace, ".git"))) {
			try {
				mkdirSync(info, { recursive: true });
				const file = join(info, "exclude");
				const current = existsSync(file) ? readFileSync(file, "utf8") : "";
				if (!current.split(String.fromCharCode(10)).some((line) => line.trim() === ".agent/")) {
					appendFileSync(file, (current && !current.endsWith(String.fromCharCode(10)) ? String.fromCharCode(10) : "") + ".agent/" + String.fromCharCode(10));
				}
			} catch {
				// sem .git gravável: segue sem o exclude
			}
		}
	}

	/** Cria .agent/output e garante .agent/ fora do git. */
	function prepareSpill() {
		mkdirSync(spillDir, { recursive: true });
		if (identity.uid !== undefined) {
			for (const dir of [spillRoot, spillDir]) {
				try {
					chownSync(dir, identity.uid, identity.gid);
				} catch {
					// sem permissão: o root continua gravando
				}
			}
		}
		ensureGitExclude();
		spillReady = true;
	}

	/** Cria o diretório de estado do shell (dono = usuário do agente). false = sem estado, o shell segue sem persistir. */
	function prepareState() {
		if (stateReady !== undefined) return stateReady;
		try {
			mkdirSync(stateDir, { recursive: true });
			if (identity.uid !== undefined) {
				for (const dir of [join(stateDir, ".."), stateDir]) {
					try {
						chownSync(dir, identity.uid, identity.gid);
					} catch {
						// sem permissão: o root continua gravando
					}
				}
			}
			ensureGitExclude();
			stateReady = true;
		} catch {
			stateReady = false;
		}
		return stateReady;
	}

	/** cwd salvo pelo último comando, se ainda existe e está dentro do workspace; senão undefined (raiz). */
	async function savedCwd() {
		try {
			const raw = readFileSync(join(stateDir, "cwd"), "utf8").trim();
			if (!raw) return undefined;
			const dir = await confine(raw);
			return statSync(dir).isDirectory() ? dir : undefined;
		} catch {
			return undefined;
		}
	}

	/** Fim do job: lê o cwd final e, se o comando saiu normalmente, promove os arquivos temporários a estado. */
	function commitState(job) {
		if (!job.state) return;
		const tmpCwd = join(stateDir, `cwd.${job.id}`);
		const tmpEnv = join(stateDir, `env.${job.id}`);
		try {
			if (job.state.save && job.status === "exited" && existsSync(tmpCwd)) {
				const dir = readFileSync(tmpCwd, "utf8").trim();
				if (dir.startsWith("/") && statSync(dir).isDirectory()) {
					job.endCwd = dir;
					renameSync(tmpCwd, join(stateDir, "cwd"));
					if (existsSync(tmpEnv)) renameSync(tmpEnv, join(stateDir, "env"));
				}
			}
		} catch {
			// estado é conveniência: nunca derruba o job
		}
		for (const file of [tmpCwd, tmpEnv]) {
			try {
				unlinkSync(file);
			} catch {
				// já promovido ou nunca criado
			}
		}
	}

	/** Acumula a saída (stdout+stderr na ordem de chegada); passado o limiar, grava em arquivo. */
	function spill(job, text) {
		const s = job.spill;
		if (s.failed || !text) return;
		try {
			if (!job.spillPath) {
				s.pending.push(text);
				s.bytes += Buffer.byteLength(text);
				if (s.bytes <= SPILL_THRESHOLD_BYTES) return;
				if (!spillReady) prepareSpill();
				const path = join(spillDir, job.id + ".txt");
				writeFileSync(path, s.pending.join(""));
				if (identity.uid !== undefined) {
					try {
						chownSync(path, identity.uid, identity.gid);
					} catch {
						// ok
					}
				}
				s.pending = [];
				job.spillPath = path;
				return;
			}
			s.bytes += Buffer.byteLength(text);
			if (s.bytes <= SPILL_MAX_BYTES) appendFileSync(job.spillPath, text);
			else if (!s.capped) {
				s.capped = true;
				appendFileSync(job.spillPath, String.fromCharCode(10) + "[saída acima de 64MB não gravada]" + String.fromCharCode(10));
			}
		} catch {
			s.failed = true;
		}
	}
	purgeSpill();

	function evict() {
		const t = now();
		for (const [id, job] of jobs) {
			if (job.endedAt && t - job.endedAt > KEEP_FINISHED_MS) jobs.delete(id);
		}
		if (jobs.size < MAX_JOBS) return;
		const finished = [...jobs.values()].filter((j) => j.endedAt).sort((a, b) => a.endedAt - b.endedAt);
		while (jobs.size >= MAX_JOBS && finished.length) jobs.delete(finished.shift().id);
		if (jobs.size >= MAX_JOBS) throw new ExecError("Muitos processos em execução; mate algum antes de iniciar outro.", 429);
	}

	function killGroup(job, signal) {
		const pid = job.child.pid;
		if (!pid) return;
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				job.child.kill(signal);
			} catch {
				// já terminou
			}
		}
	}

	async function start(input, { background = false } = {}) {
		const cmd = input?.cmd;
		if (typeof cmd !== "string" || !cmd.trim()) throw new ExecError("cmd obrigatório");
		if (cmd.length > MAX_CMD_CHARS) throw new ExecError("cmd grande demais");
		const cwd = await confine(input.cwd ?? (await savedCwd()) ?? workspace);
		const { env: userEnv, secrets } = sanitizeEnv(input.env);
		// Com auto-background o job só morre no teto máximo; `timeoutMs` explícito ainda vale.
		const timeoutMs = input.autoBackgroundMs !== undefined && input.timeoutMs === undefined ? MAX_TIMEOUT_MS : clampTimeout(input.timeoutMs);
		evict();

		const baseEnv = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			USER: "dev",
			LOGNAME: "dev",
			LANG: "C.UTF-8",
			TERM: "dumb",
			CI: "true",
			GIT_TERMINAL_PROMPT: "0",
			...NETWORK_DEFAULTS,
			...cacheEnv(),
			...(options.extraEnv ? options.extraEnv() : {}),
		};
		const id = randomBytes(6).toString("hex");
		const state = prepareState() ? { save: !background } : undefined;
		const script = state ? shellStatePrefix({ dir: stateDir, id, save: state.save }) + cmd : cmd;
		const child = spawnFn("bash", ["-lc", script], {
			cwd,
			env: { ...baseEnv, ...userEnv },
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			...(identity.uid !== undefined ? { uid: identity.uid, gid: identity.gid } : {}),
		});
		const job = {
			id,
			child,
			cwd,
			norm: normalizeCmd(cmd),
			startedAt: now(),
			endedAt: undefined,
			exitCode: null,
			signal: null,
			status: "running",
			stdout: createOutputBuffer({ maxBytes: bufferBytes }),
			stderr: createOutputBuffer({ maxBytes: bufferBytes }),
			waiters: new Set(),
			timer: undefined,
			killTimer: undefined,
			secrets,
			background,
			spill: { pending: [], bytes: 0, failed: false, capped: false },
			spillPath: undefined,
			state,
			endCwd: undefined,
		};
		jobs.set(id, job);

		const wake = () => {
			for (const fn of [...job.waiters]) fn();
		};
		for (const [stream, buffer] of [
			[child.stdout, job.stdout],
			[child.stderr, job.stderr],
		]) {
			const decoder = new StringDecoder("utf8");
			stream?.on("data", (data) => {
				const text = redact(decoder.write(data), job.secrets);
				buffer.append(text);
				spill(job, text);
				wake();
			});
		}
		child.stdin?.on("error", () => undefined);
		let settled = false;
		const finish = (exitCode, signal, failure) => {
			if (settled) return;
			settled = true;
			clearTimeout(job.timer);
			clearTimeout(job.killTimer);
			job.endedAt = now();
			job.exitCode = exitCode;
			job.signal = signal ?? null;
			if (failure) job.stderr.append(`${failure}\n`);
			if (job.status === "running") job.status = "exited";
			commitState(job);
			wake();
			if (job.background) {
				try {
					options.onEnd?.({ jobId: job.id, status: job.status, exitCode: job.exitCode, durationMs: job.endedAt - job.startedAt, endedAt: job.endedAt });
				} catch {
					// o aviso nunca atrapalha o job
				}
			}
		};
		child.once("error", (error) => finish(127, null, `Falha ao iniciar: ${error.message}`));
		child.once("close", (code, signal) => finish(code ?? (signal ? 128 : 0), signal));

		job.timer = setTimeout(() => {
			if (job.endedAt) return;
			job.status = "timeout";
			killGroup(job, "SIGTERM");
			job.killTimer = setTimeout(() => killGroup(job, "SIGKILL"), KILL_GRACE_MS);
		}, timeoutMs);
		job.timer.unref?.();
		return job;
	}

	function get(id) {
		const job = jobs.get(id);
		if (!job) throw new ExecError(`Processo não encontrado: ${id} (a sandbox foi recriada ou o resultado expirou)`, 404);
		return job;
	}

	/** Espera exit, saída nova ou `waitMs`. */
	function waitForChange(job, waitMs, since) {
		if (job.endedAt || waitMs <= 0) return Promise.resolve();
		if (job.stdout.total > since.out || job.stderr.total > since.err) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				job.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, waitMs);
			job.waiters.add(done);
		});
	}

	/** Espera qualquer atividade do job (saída ou fim) ou `ms`. */
	function waitWake(job, ms) {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				job.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			job.waiters.add(done);
		});
	}

	function snapshot(job, since = {}, cap = RETURN_CAP_BYTES) {
		const out = job.stdout.read(since.out ?? 0, cap);
		const err = job.stderr.read(since.err ?? 0, cap);
		return {
			id: job.id,
			status: job.status,
			running: !job.endedAt,
			exitCode: job.endedAt ? job.exitCode : null,
			signal: job.signal,
			timedOut: job.status === "timeout",
			stdout: out.text,
			stderr: err.text,
			nextOut: out.nextOffset,
			nextErr: err.nextOffset,
			truncated: out.truncated || err.truncated,
			omittedBytes: out.omittedBytes + err.omittedBytes,
			durationMs: (job.endedAt ?? now()) - job.startedAt,
			cwd: job.cwd,
			...(job.endCwd ? { endCwd: job.endCwd } : {}),
			...(job.spillPath ? { spillPath: job.spillPath } : {}),
		};
	}

	/** Job ainda rodando com o mesmo comando (normalizado) e diretório: evita relançar o mesmo install/teste. */
	async function findRunning(input) {
		if (typeof input?.cmd !== "string" || !input.cmd.trim()) return null;
		const cwd = await confine(input.cwd ?? workspace);
		const norm = normalizeCmd(input.cmd);
		for (const job of jobs.values()) if (!job.endedAt && job.norm === norm && job.cwd === cwd) return job;
		return null;
	}

	return {
		start,
		findRunning,
		get,
		snapshot,
		/**
		 * Primeiro plano: espera o fim (ou o timeout do job) e devolve o resultado completo. Com
		 * `autoBackgroundMs` (em `input` ou nas opções), passado esse tempo o comando NÃO é morto:
		 * vira um job em segundo plano (callback de fim, varredura e eventos funcionam) e o
		 * resultado volta com `backgrounded: true` e o `id` do job.
		 */
		async run(input, { signal, autoBackgroundMs } = {}) {
			const rawAuto = autoBackgroundMs ?? input?.autoBackgroundMs;
			const auto = rawAuto === undefined || rawAuto === null ? undefined : Math.min(MAX_AUTO_BACKGROUND_MS, Math.max(1_000, Math.floor(Number(rawAuto)) || DEFAULT_AUTO_BACKGROUND_MS));
			const job = await start(auto === undefined ? input : { ...input, autoBackgroundMs: auto });
			const abort = () => {
				job.status = "killed";
				killGroup(job, "SIGKILL");
			};
			signal?.addEventListener("abort", abort, { once: true });
			while (!job.endedAt) {
				if (auto !== undefined) {
					const remaining = auto - (now() - job.startedAt);
					if (remaining <= 0) {
						signal?.removeEventListener("abort", abort);
						job.background = true;
						return { ...snapshot(job), backgrounded: true };
					}
					await waitForChange(job, Math.min(1_000, remaining), { out: Infinity, err: Infinity });
				} else {
					await waitForChange(job, 1_000, { out: Infinity, err: Infinity });
				}
			}
			signal?.removeEventListener("abort", abort);
			return snapshot(job);
		},
		/**
		 * Long-poll: volta no fim do job, em saída nova ou após `waitMs`. Com `until` (substring ou
		 * `/regex/flags`) só volta cedo quando a saída NOVA (desde out/err) casa com a condição
		 * (`matched: true`), no fim do job ou no prazo.
		 */
		async poll(id, { out = 0, err = 0, waitMs = 0, until } = {}) {
			const job = get(id);
			const wait = Math.min(MAX_POLL_WAIT_MS, Math.max(0, waitMs));
			const test = compileUntil(until);
			if (!test) {
				await waitForChange(job, wait, { out, err });
				return snapshot(job, { out, err });
			}
			const deadline = Date.now() + wait;
			let matched = false;
			for (;;) {
				const text = job.stdout.read(out, UNTIL_WINDOW_BYTES).text + String.fromCharCode(10) + job.stderr.read(err, UNTIL_WINDOW_BYTES).text;
				if (test(text)) {
					matched = true;
					break;
				}
				const remaining = deadline - Date.now();
				if (job.endedAt || remaining <= 0) break;
				await waitWake(job, remaining);
			}
			return { ...snapshot(job, { out, err }), matched };
		},
		stdin(id, { data, end } = {}) {
			const job = get(id);
			if (job.endedAt) throw new ExecError("O processo já terminou", 409);
			if (typeof data === "string" && data.length) {
				if (data.length > 1_000_000) throw new ExecError("stdin grande demais");
				job.child.stdin?.write(data);
			}
			if (end) job.child.stdin?.end();
			return { ok: true };
		},
		kill(id, signal = "SIGTERM") {
			const job = get(id);
			if (job.endedAt) return { ok: true, alreadyExited: true };
			const sig = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
			job.status = "killed";
			killGroup(job, sig);
			if (sig === "SIGTERM") {
				clearTimeout(job.killTimer);
				job.killTimer = setTimeout(() => killGroup(job, "SIGKILL"), KILL_GRACE_MS);
			}
			return { ok: true };
		},
		list() {
			return [...jobs.values()].map((j) => ({ id: j.id, status: j.status, running: !j.endedAt, startedAt: j.startedAt }));
		},
	};
}
