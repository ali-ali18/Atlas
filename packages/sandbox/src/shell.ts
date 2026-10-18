import { randomBytes } from "node:crypto";
import type {
	SandboxDownloadResult,
	SandboxListEntry,
	SandboxListResult,
	SandboxReadResult,
	SandboxShellResult,
	SandboxShellWaitResult,
	SandboxWriteFileResult,
} from "./types.js";

/**
 * Ferramentas de shell/arquivo DENTRO do container da sandbox. Nada aqui toca o
 * host: tudo passa por um `ShellExecutor` (docker exec no container do bot).
 * O executor é o seam de teste.
 */

export const SANDBOX_USER = "atlas";
export const SANDBOX_HOME = "/home/atlas";
export const SANDBOX_WORK_DIR = "/home/atlas/work";
const JOBS_DIR = `${SANDBOX_WORK_DIR}/.jobs`;
const COOKIE_DIR = `${SANDBOX_WORK_DIR}/.cookies`;

export const SHELL_DEFAULT_TIMEOUT_S = 60;
export const SHELL_MAX_TIMEOUT_S = 600;
export const SHELL_BACKGROUND_MAX_TIMEOUT_S = 3600;
export const SHELL_WAIT_DEFAULT_S = 30;
export const SHELL_WAIT_MAX_S = 120;
export const OUTPUT_MAX_CHARS = 16_000;
export const READ_MAX_CHARS = 40_000;
export const READ_DEFAULT_LINES = 2000;
export const LIST_MAX_ENTRIES = 300;
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

export type ShellExecOptions = {
	cmd: string[];
	user?: string;
	workingDir?: string;
	env?: string[];
	/** Bytes enviados à entrada padrão do comando (escrita binária sem passar por argv). */
	stdin?: Uint8Array;
};
export type ShellExecResult = { stdout: string; stderr: string; exitCode: number };
export type ShellExecutor = (options: ShellExecOptions) => Promise<ShellExecResult>;

export class SandboxShellError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxShellError";
	}
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Mantém começo e fim (o erro costuma estar no fim) e avisa o que foi cortado. */
export function truncateOutput(text: string, max = OUTPUT_MAX_CHARS): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return {
		text: `${text.slice(0, head)}\n[... ${omitted} chars omitidos; redirecione a saída para um arquivo e use sandbox_read com offset/limit ...]\n${text.slice(text.length - tail)}`,
		truncated: true,
	};
}

function checkPath(path: string, label = "path"): string {
	const trimmed = path.trim();
	if (!trimmed) throw new SandboxShellError(`${label} vazio`);
	if (trimmed.includes("\0")) throw new SandboxShellError(`${label} inválido`);
	return trimmed;
}

/** Caminho relativo vale a partir do diretório de trabalho; `~` é o home do usuário. */
export function resolveSandboxPath(path: string): string {
	const p = checkPath(path);
	if (p === "~") return SANDBOX_HOME;
	if (p.startsWith("~/")) return `${SANDBOX_HOME}/${p.slice(2)}`;
	if (p.startsWith("/")) return p;
	return `${SANDBOX_WORK_DIR}/${p}`;
}

export async function runShell(
	exec: ShellExecutor,
	input: { command: string; cwd?: string; timeoutS?: number; background?: boolean },
	now: () => number = Date.now,
): Promise<SandboxShellResult> {
	const command = input.command;
	if (!command?.trim()) throw new SandboxShellError("command vazio");
	const cwd = input.cwd ? resolveSandboxPath(input.cwd) : SANDBOX_WORK_DIR;

	if (input.background) {
		const timeoutS = clampInt(input.timeoutS, 1800, 1, SHELL_BACKGROUND_MAX_TIMEOUT_S);
		const jobId = randomBytes(6).toString("hex");
		const script =
			'mkdir -p "$JOB_DIR" && cd "$JOB_CWD" || exit 3; ' +
			'( setsid nohup bash -c \'timeout -k 3 "$JOB_TIMEOUT" bash -lc "$JOB_CMD" >"$JOB_DIR/$JOB_ID.out" 2>&1; echo $? >"$JOB_DIR/$JOB_ID.exit"\' >/dev/null 2>&1 & ); echo started';
		const result = await exec({
			cmd: ["bash", "-c", script],
			user: SANDBOX_USER,
			workingDir: SANDBOX_WORK_DIR,
			env: [`JOB_DIR=${JOBS_DIR}`, `JOB_CWD=${cwd}`, `JOB_TIMEOUT=${timeoutS}`, `JOB_CMD=${command}`, `JOB_ID=${jobId}`],
		});
		if (result.exitCode !== 0) {
			throw new SandboxShellError(`Não foi possível iniciar o job (cwd inválido?): ${result.stderr.trim() || `exit ${result.exitCode}`}`);
		}
		return { background: true, jobId, exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncated: false };
	}

	const timeoutS = clampInt(input.timeoutS, SHELL_DEFAULT_TIMEOUT_S, 1, SHELL_MAX_TIMEOUT_S);
	const started = now();
	const result = await exec({
		cmd: ["timeout", "-k", "3", String(timeoutS), "bash", "-lc", command],
		user: SANDBOX_USER,
		workingDir: cwd,
	});
	const durationMs = now() - started;
	const timedOut = result.exitCode === 124 || result.exitCode === 137;
	const out = truncateOutput(result.stdout);
	const err = truncateOutput(result.stderr);
	return {
		background: false,
		exitCode: result.exitCode,
		stdout: out.text,
		stderr: err.text,
		durationMs,
		timedOut,
		truncated: out.truncated || err.truncated,
	};
}

const JOB_ID = /^[a-f0-9]{12}$/;
/** Cursor de leitura por job (saída incremental), em memória do processo. */
const jobCursors = new Map<string, number>();

export async function waitShell(
	exec: ShellExecutor,
	input: { jobId: string; timeoutS?: number; offset?: number },
	options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SandboxShellWaitResult> {
	if (!JOB_ID.test(input.jobId ?? "")) throw new SandboxShellError("job_id inválido");
	const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = options.now ?? Date.now;
	const timeoutS = clampInt(input.timeoutS, SHELL_WAIT_DEFAULT_S, 0, SHELL_WAIT_MAX_S);
	const deadline = now() + timeoutS * 1000;
	const probe = `o="${JOBS_DIR}/${input.jobId}.out"; e="${JOBS_DIR}/${input.jobId}.exit"; ` +
		'[ -e "$o" ] || { echo missing; exit 0; }; if [ -f "$e" ]; then echo "done $(cat "$e")"; else echo running; fi';
	let state: { done: boolean; exitCode: number | null } = { done: false, exitCode: null };
	for (;;) {
		const p = await exec({ cmd: ["bash", "-c", probe], user: SANDBOX_USER });
		const line = p.stdout.trim();
		if (line === "missing") throw new SandboxShellError(`Job não encontrado: ${input.jobId} (a sandbox foi recriada?)`);
		if (line.startsWith("done")) {
			const code = Number.parseInt(line.slice(5), 10);
			state = { done: true, exitCode: Number.isFinite(code) ? code : null };
			break;
		}
		if (now() >= deadline) break;
		await sleep(Math.min(1000, Math.max(0, deadline - now())));
	}
	const from = input.offset ?? jobCursors.get(input.jobId) ?? 0;
	const read = await exec({
		cmd: ["bash", "-c", `tail -c +$(( $1 + 1 )) "${JOBS_DIR}/${input.jobId}.out" | head -c 200000`, "_", String(Math.max(0, Math.floor(from)))],
		user: SANDBOX_USER,
	});
	const raw = read.stdout;
	const out = truncateOutput(raw);
	const nextOffset = Math.max(0, Math.floor(from)) + Buffer.byteLength(raw);
	jobCursors.set(input.jobId, nextOffset);
	if (state.done) jobCursors.delete(input.jobId);
	return { jobId: input.jobId, status: state.done ? "done" : "running", exitCode: state.exitCode, output: out.text, nextOffset, truncated: out.truncated };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

export async function readSandboxFile(
	exec: ShellExecutor,
	input: { path: string; offset?: number; limit?: number },
): Promise<SandboxReadResult> {
	const path = resolveSandboxPath(input.path);
	const st = await exec({ cmd: ["stat", "-L", "-c", "%s %F", "--", path], user: SANDBOX_USER });
	if (st.exitCode !== 0) throw new SandboxShellError(`Arquivo não encontrado ou sem permissão: ${path}`);
	const [sizeText, ...kindParts] = st.stdout.trim().split(" ");
	const size = Number.parseInt(sizeText ?? "0", 10) || 0;
	const kind = kindParts.join(" ");
	if (kind === "directory") throw new SandboxShellError(`${path} é um diretório; use sandbox_list`);

	if (IMAGE_EXT.test(path)) {
		return {
			path, kind: "image", size, content: "", totalLines: 0, nextOffset: null, truncated: false,
			note: `Arquivo de imagem (${size} bytes). Não leio pixels aqui: abra file://${path} no navegador da VM (navigate) e use screenshot, ou use show_image se já for um artefato.`,
		};
	}

	const isPdf = /\.pdf$/i.test(path);
	let text: string;
	if (isPdf) {
		const r = await exec({ cmd: ["pdftotext", "-layout", "-enc", "UTF-8", "--", path, "-"], user: SANDBOX_USER });
		if (r.exitCode !== 0) {
			throw new SandboxShellError(`pdftotext falhou (${r.exitCode}): ${r.stderr.trim().slice(0, 300) || "PDF inválido ou protegido"}`);
		}
		text = r.stdout;
		if (!text.trim()) {
			return {
				path, kind: "pdf", size, content: "", totalLines: 0, nextOffset: null, truncated: false,
				note: "PDF sem camada de texto (provavelmente escaneado). Abra no navegador (file://) e use screenshot.",
			};
		}
	} else {
		const r = await exec({ cmd: ["head", "-c", "3000000", "--", path], user: SANDBOX_USER });
		if (r.exitCode !== 0) throw new SandboxShellError(`Falha ao ler ${path}: ${r.stderr.trim().slice(0, 300)}`);
		text = r.stdout;
		if (text.includes("\0")) {
			return {
				path, kind: "binary", size, content: "", totalLines: 0, nextOffset: null, truncated: false,
				note: "Arquivo binário; não é texto. Converta antes (ex.: unzip, pdftotext, python3) com sandbox_shell.",
			};
		}
	}

	const lines = text.split("\n");
	const start = Math.max(0, Math.floor(input.offset ?? 0));
	const limit = clampInt(input.limit, READ_DEFAULT_LINES, 1, 10_000);
	let slice = lines.slice(start, start + limit).join("\n");
	let end = Math.min(lines.length, start + limit);
	let truncated = end < lines.length;
	if (slice.length > READ_MAX_CHARS) {
		slice = slice.slice(0, READ_MAX_CHARS);
		end = start + slice.split("\n").length - 1;
		truncated = true;
	}
	return {
		path, kind: isPdf ? "pdf" : "text", size, content: slice, totalLines: lines.length,
		nextOffset: truncated ? end : null, truncated,
		note: truncated ? `Mostrando linhas ${start}-${end} de ${lines.length}. Continue com offset=${end}.` : undefined,
	};
}

/** Teto de um arquivo escrito de fora para dentro da VM (anexos do usuário). */
export const WRITE_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Grava bytes num arquivo da VM (cria as pastas) pela entrada padrão de `cat`; o conteúdo nunca vira
 * argumento de comando nem é executado. Caminho confinado ao home do usuário `atlas`.
 */
export async function writeSandboxFile(exec: ShellExecutor, input: { path: string; bytes: Uint8Array }): Promise<SandboxWriteFileResult> {
	const path = resolveSandboxPath(input.path);
	if (!path.startsWith(`${SANDBOX_HOME}/`) || path.split("/").includes("..")) throw new SandboxShellError(`Só é possível gravar dentro de ${SANDBOX_HOME}`);
	if (input.bytes.byteLength > WRITE_FILE_MAX_BYTES) throw new SandboxShellError("Arquivo grande demais para copiar");
	const result = await exec({
		cmd: ["bash", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "_", path],
		user: SANDBOX_USER,
		stdin: input.bytes,
	});
	if (result.exitCode !== 0) throw new SandboxShellError(`Falha ao gravar ${path}: ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}`);
	return { path, bytes: input.bytes.byteLength };
}

export async function listSandboxDir(exec: ShellExecutor, input: { path: string }): Promise<SandboxListResult> {
	const path = resolveSandboxPath(input.path || ".");
	const r = await exec({
		cmd: ["find", path, "-maxdepth", "1", "-mindepth", "1", "-printf", "%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%f\n"],
		user: SANDBOX_USER,
	});
	if (r.exitCode !== 0 && !r.stdout) throw new SandboxShellError(`Diretório não encontrado ou sem permissão: ${path}`);
	const all: SandboxListEntry[] = r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [type = "f", size = "0", modified = "", ...name] = line.split("\t");
			return { name: name.join("\t"), type: (type === "d" ? "dir" : type === "l" ? "link" : "file") as SandboxListEntry["type"], size: Number.parseInt(size, 10) || 0, modified };
		})
		.filter((entry) => !entry.name.startsWith(".jobs") && !entry.name.startsWith(".cookies"))
		.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return { path, entries: all.slice(0, LIST_MAX_ENTRIES), total: all.length, truncated: all.length > LIST_MAX_ENTRIES };
}

function defaultDownloadName(url: URL): string {
	const base = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
	return base || `download-${Date.now().toString(36)}`;
}

export async function downloadToSandbox(
	exec: ShellExecutor,
	input: { url: string; path?: string; useBrowserSession?: boolean },
): Promise<SandboxDownloadResult> {
	let url: URL;
	try {
		url = new URL(input.url);
	} catch {
		throw new SandboxShellError("url inválida");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new SandboxShellError("Só http(s) é permitido");
	let target = input.path ? resolveSandboxPath(input.path) : `${SANDBOX_WORK_DIR}/downloads/${defaultDownloadName(url)}`;
	if (target.endsWith("/")) target += defaultDownloadName(url);

	let jar: string | null = null;
	let cookieNote: string | undefined;
	if (input.useBrowserSession !== false) {
		const jarPath = `${COOKIE_DIR}/${randomBytes(6).toString("hex")}.txt`;
		// Root só para falar com o Chrome (perfil do root); o jar fica 0600 do usuário.
		const prep = await exec({
			cmd: ["bash", "-c", `install -d -m 700 -o ${SANDBOX_USER} -g ${SANDBOX_USER} "${COOKIE_DIR}" && node /app/control/export-cookies.mjs "$1" "$2" && chown ${SANDBOX_USER}:${SANDBOX_USER} "$2"`, "_", url.toString(), jarPath],
			user: "root",
		});
		if (prep.exitCode === 0) jar = jarPath;
		else cookieNote = "Sessão do navegador indisponível (Chrome fechado?); baixei sem cookies.";
	}

	const args = [
		"curl", "-fsSL", "--create-dirs", "--max-time", "300", "--max-filesize", String(DOWNLOAD_MAX_BYTES),
		"-A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
		...(jar ? ["-b", jar] : []),
		"-o", target, "-w", "%{http_code}\t%{content_type}\t%{size_download}", "--", url.toString(),
	];
	let result: ShellExecResult;
	try {
		result = await exec({ cmd: args, user: SANDBOX_USER, workingDir: SANDBOX_WORK_DIR });
	} finally {
		if (jar) await exec({ cmd: ["rm", "-f", "--", jar], user: SANDBOX_USER }).catch(() => undefined);
	}
	if (result.exitCode !== 0) {
		throw new SandboxShellError(`Download falhou (curl ${result.exitCode}): ${result.stderr.trim().slice(0, 300) || "erro de rede/HTTP"}`);
	}
	const [status = "", contentType = "", bytes = "0"] = result.stdout.trim().split("\t");
	return {
		path: target, httpStatus: Number.parseInt(status, 10) || 0, contentType, bytes: Number.parseInt(bytes, 10) || 0,
		usedBrowserSession: Boolean(jar), note: cookieNote,
	};
}
