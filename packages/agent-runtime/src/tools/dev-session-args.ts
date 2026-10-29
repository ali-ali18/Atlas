import { DEV_SHELL_OUTPUT_MAX_WAIT_MS, parsePrReference } from "@workspace/shared";
import { DEV_TIER_NAMES, type DevTier } from "@workspace/sandbox";

/**
 * Validação de argumentos e formatação das tools de sessão de desenvolvimento.
 * Tudo puro: os erros são em pt-BR e viram `tool_result` de erro para o modelo.
 */

/** Quanto o `shell` em primeiro plano espera antes de virar job em segundo plano (o comando NÃO é morto). */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;
export const MAX_CMD_CHARS = 100_000;
export const MAX_WRITE_CHARS = 2_000_000;
/** Teto do texto de um resultado de tool devolvido ao modelo. */
export const RESULT_CAP_BYTES = 48 * 1024;

function str(value: unknown, field: string, { max = 10_000, allowEmpty = false } = {}): string {
	if (typeof value !== "string") throw new Error(`${field} exige um texto`);
	if (!allowEmpty && !value.trim()) throw new Error(`${field} não pode ser vazio`);
	if (value.length > max) throw new Error(`${field} grande demais (máximo ${max} caracteres)`);
	return value;
}

function optStr(value: unknown, field: string, max = 4_000): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return str(value, field, { max });
}

function optInt(value: unknown, field: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} inválido: use um número entre ${min} e ${max}`);
	return Math.floor(n);
}

function optBool(value: unknown, field: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} deve ser true ou false`);
	return value;
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Nome de branch seguro para ir em argv/env (sem espaço, `..`, `-` inicial ou `.lock`). */
export function isSafeRef(ref: string): boolean {
	return SAFE_REF.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.endsWith(".");
}

export type ParsedRepo = { url: string; label: string; dirName: string };

/** Aceita `owner/name`, URL https (com ou sem .git) e `git@github.com:owner/name.git`. */
export function parseRepo(input: string): ParsedRepo {
	const raw = input.trim();
	const slug = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(raw);
	if (slug) {
		const name = slug[2]!.replace(/\.git$/, "");
		return { url: `https://github.com/${slug[1]}/${name}.git`, label: `${slug[1]}/${name}`, dirName: name };
	}
	const ssh = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw);
	if (ssh) return parseRepo(`${ssh[1]}/${ssh[2]}`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("repo inválido: use owner/nome ou uma URL https do repositório");
	}
	if (url.protocol !== "https:") throw new Error("repo inválido: só URLs https são aceitas");
	if (url.username || url.password) throw new Error("repo inválido: não coloque credenciais na URL");
	const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
	if (parts.length < 2) throw new Error("repo inválido: a URL deve apontar para um repositório");
	const name = parts[parts.length - 1]!;
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") throw new Error("repo inválido: nome de repositório inesperado");
	const clean = `https://${url.host}${url.pathname.replace(/\.git$/, "")}.git`;
	return {
		url: clean,
		label: url.host === "github.com" ? parts.slice(-2).join("/") : clean,
		dirName: name,
	};
}

/** Aspas simples seguras para montar comandos bash a partir de valores validados. */
export function shq(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export type StartArgs = { repo?: ParsedRepo; branch?: string; baseBranch?: string; tier?: DevTier };

export function parseStartArgs(args: Record<string, unknown>): StartArgs {
	const repoRaw = optStr(args.repo, "repo", 500);
	const branch = optStr(args.branch, "branch", 200);
	const baseBranch = optStr(args.baseBranch, "baseBranch", 200);
	for (const [value, field] of [[branch, "branch"], [baseBranch, "baseBranch"]] as const) {
		if (value !== undefined && !isSafeRef(value)) throw new Error(`${field} inválido: use letras, números, ponto, hífen, barra e sublinhado`);
	}
	const tierRaw = optStr(args.tier, "tier", 20);
	if (tierRaw !== undefined && !(DEV_TIER_NAMES as readonly string[]).includes(tierRaw)) {
		throw new Error(`tier deve ser um de: ${DEV_TIER_NAMES.join(", ")}`);
	}
	if ((branch || baseBranch) && !repoRaw) throw new Error("branch/baseBranch exigem repo");
	return {
		...(repoRaw ? { repo: parseRepo(repoRaw) } : {}),
		...(branch ? { branch } : {}),
		...(baseBranch ? { baseBranch } : {}),
		...(tierRaw ? { tier: tierRaw as DevTier } : {}),
	};
}

export type ShellArgs = { cmd: string; cwd?: string; timeoutMs: number; background: boolean };

export function parseShellArgs(args: Record<string, unknown>): ShellArgs {
	return {
		cmd: str(args.cmd, "cmd", { max: MAX_CMD_CHARS }),
		cwd: optStr(args.cwd, "cwd", 1_000),
		timeoutMs: optInt(args.timeoutMs ?? args.timeout_ms, "timeoutMs", { min: 1_000, max: MAX_SHELL_TIMEOUT_MS }) ?? DEFAULT_SHELL_TIMEOUT_MS,
		background: optBool(args.background, "background") ?? false,
	};
}

const JOB_ID = /^[a-f0-9]{12}$/;

function jobId(value: unknown): string {
	const id = str(value, "jobId", { max: 40 }).trim();
	if (!JOB_ID.test(id)) throw new Error("jobId inválido: use o job_id devolvido por shell");
	return id;
}

export function parseShellOutputArgs(args: Record<string, unknown>) {
	return {
		jobId: jobId(args.jobId),
		offset: optInt(args.offset, "offset", { min: 0 }),
		waitMs: optInt(args.waitMs, "waitMs", { min: 0, max: DEV_SHELL_OUTPUT_MAX_WAIT_MS }),
		until: optStr(args.until, "until", 300),
	};
}

export function parseShellStdinArgs(args: Record<string, unknown>) {
	const data = optStr(args.data, "data", 100_000);
	const end = optBool(args.end, "end");
	if (data === undefined && !end) throw new Error("informe data e/ou end:true");
	return { jobId: jobId(args.jobId), data, end: end ?? false };
}

export function parseShellKillArgs(args: Record<string, unknown>) {
	return { jobId: jobId(args.jobId), force: optBool(args.force, "force") ?? false };
}

export function parseReadFileArgs(args: Record<string, unknown>) {
	const startLine = optInt(args.startLine, "startLine", { min: 1 });
	const endLine = optInt(args.endLine, "endLine", { min: 1 });
	if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new Error("endLine deve ser >= startLine");
	return { path: str(args.path, "path", { max: 1_000 }), startLine, endLine };
}

export function parseWriteFileArgs(args: Record<string, unknown>) {
	return {
		path: str(args.path, "path", { max: 1_000 }),
		content: str(args.content, "content", { max: MAX_WRITE_CHARS, allowEmpty: true }),
	};
}

export function parseEditFileArgs(args: Record<string, unknown>) {
	const oldText = str(args.old, "old", { max: MAX_WRITE_CHARS });
	const newText = str(args.new, "new", { max: MAX_WRITE_CHARS, allowEmpty: true });
	if (oldText === newText) throw new Error("old e new são iguais; nada a mudar");
	return {
		path: str(args.path, "path", { max: 1_000 }),
		old: oldText,
		new: newText,
		replaceAll: optBool(args.replaceAll, "replaceAll") ?? false,
	};
}

export function parseListFilesArgs(args: Record<string, unknown>) {
	return { path: optStr(args.path, "path", 1_000), depth: optInt(args.depth, "depth", { min: 1, max: 6 }) };
}

export function parseGrepArgs(args: Record<string, unknown>) {
	return {
		pattern: str(args.pattern, "pattern", { max: 2_000 }),
		path: optStr(args.path, "path", 1_000),
		glob: optStr(args.glob, "glob", 200),
		ignoreCase: optBool(args.ignoreCase, "ignoreCase"),
		fixed: optBool(args.fixed, "fixed"),
	};
}

/** Mantém o FIM do texto (o erro costuma estar lá) dentro do teto de bytes. */
export function capResultText(text: string, cap = RESULT_CAP_BYTES): string {
	const bytes = Buffer.byteLength(text);
	if (bytes <= cap) return text;
	const tail = Buffer.from(text, "utf8").subarray(bytes - cap).toString("utf8").replace(/^�+/, "");
	return `[... ${bytes - cap} bytes iniciais omitidos; use shell_output com offset ou redirecione a saída para um arquivo ...]\n${tail}`;
}

/** Máximo de caracteres de saída de shell mostrados inline; o resto vai para o arquivo de saída do job. */
export const SHELL_INLINE_MAX_CHARS = 30_000;

/** Mantém o começo e o fim (o erro costuma estar no fim, o contexto no começo) e marca o que foi omitido. */
export function capHeadTail(text: string, max = SHELL_INLINE_MAX_CHARS): { text: string; omitted: number } {
	if (text.length <= max) return { text, omitted: 0 };
	const head = Math.floor(max / 3);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return { text: `${text.slice(0, head)}\n[… ${omitted} caracteres omitidos …]\n${text.slice(text.length - tail)}`, omitted };
}

/** Bloco "região editada" para o resultado de edit_file/write_file (o modelo não precisa reler). */
export function formatEditExcerpt(excerpt: { firstLine: number; text: string } | undefined, redact: (text: string) => string): string {
	if (!excerpt?.text) return "";
	const last = excerpt.firstLine + excerpt.text.split("\n").length - 1;
	return `\nRegião editada (linhas ${excerpt.firstLine}-${last}; não precisa reler):\n${numberLines(redact(excerpt.text), excerpt.firstLine)}`;
}

/** Texto numerado (`  12\tlinha`) a partir de `firstLine` (1-based). */
export function numberLines(content: string, firstLine: number): string {
	if (!content) return "";
	return content
		.split("\n")
		.map((line, index) => `${String(firstLine + index).padStart(6)}\t${line}`)
		.join("\n");
}

// ----- pull request e CI -----

export const PR_TITLE_MAX = 256;
export const PR_BODY_MAX = 60_000;

export type PrCreateArgs = { title: string; body: string; base?: string; draft: boolean };

export function parsePrCreateArgs(args: Record<string, unknown>): PrCreateArgs {
	const title = str(args.title, "title", { max: PR_TITLE_MAX }).trim().replace(/\s+/g, " ");
	const body = str(args.body, "body", { max: PR_BODY_MAX, allowEmpty: true }).trim();
	const base = optStr(args.base, "base", 200);
	if (base !== undefined && !isSafeRef(base)) throw new Error("base inválida: use letras, números, ponto, hífen, barra e sublinhado");
	return { title, body, ...(base ? { base } : {}), draft: optBool(args.draft, "draft") ?? false };
}

export type PrRefArgs = { number: number; repo?: string };

/** `number` aceita 42, "#42" ou a URL do PR (a URL também define o repo). */
export function parsePrCheckoutArgs(args: Record<string, unknown>): PrRefArgs {
	return parsePrRef(args.number ?? args.pr, args.repo);
}

function parsePrRef(raw: unknown, repoRaw: unknown): PrRefArgs {
	const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
	const ref = parsePrReference(text);
	if (!ref || ref.number < 1) throw new Error("informe o número do PR (ex.: 42) ou a URL https://github.com/owner/nome/pull/42");
	const repoArg = optStr(repoRaw, "repo", 500);
	const repo = repoArg ? parseRepo(repoArg).label : ref.repo;
	return { number: ref.number, ...(repo ? { repo } : {}) };
}

export type CiStatusArgs = { number?: number; repo?: string };

/** Sem número: o PR da sessão. */
export function parseCiStatusArgs(args: Record<string, unknown>): CiStatusArgs {
	if (args.number === undefined && args.pr === undefined && args.repo === undefined) return {};
	if (args.number === undefined && args.pr === undefined) return { repo: parseRepo(str(args.repo, "repo", { max: 500 })).label };
	return parsePrRef(args.number ?? args.pr, args.repo);
}

export type CiLogsArgs = { jobId?: number; runId?: number; repo?: string; maxChars: number };

export function parseCiLogsArgs(args: Record<string, unknown>): CiLogsArgs {
	const jobId = optInt(args.jobId, "jobId", { min: 1 });
	const runId = optInt(args.runId, "runId", { min: 1 });
	if (jobId !== undefined && runId !== undefined) throw new Error("informe jobId OU runId, não os dois");
	const repoArg = optStr(args.repo, "repo", 500);
	return {
		...(jobId !== undefined ? { jobId } : {}),
		...(runId !== undefined ? { runId } : {}),
		...(repoArg ? { repo: parseRepo(repoArg).label } : {}),
		maxChars: optInt(args.maxChars, "maxChars", { min: 500, max: 20_000 }) ?? 6_000,
	};
}
