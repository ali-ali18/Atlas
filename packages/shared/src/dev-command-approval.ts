/**
 * Aprovação de comandos das sessões de código (equivalente ao "ask every time /
 * allowlist / run everything" do Cursor). Tudo puro: análise do comando de shell,
 * lista liberada por prefixo, lista de bloqueio fixa e resolução do modo.
 *
 * Nos modos "Lista liberada" e "Perguntar sempre" a análise é conservadora; no
 * "Automático" só o bloqueio fixo e as ações "para fora" ou sem volta
 * (`riskyReason`) pedem aprovação, e o que não dá para entender roda. Nos outros: o que não dá para entender com
 * certeza (heredoc, substituição de processo, variável no lugar do comando…)
 * vira "pergunte".
 */

export const DEV_APPROVAL_MODES = ["ask", "allowlist", "auto"] as const;
export type DevApprovalMode = (typeof DEV_APPROVAL_MODES)[number];

export const DEFAULT_DEV_APPROVAL_MODE: DevApprovalMode = "auto";

export const DEV_APPROVAL_MODE_LABEL: Record<DevApprovalMode, string> = {
	ask: "Perguntar sempre",
	allowlist: "Lista liberada",
	auto: "Automático",
};

export const DEV_APPROVAL_MODE_HELP: Record<DevApprovalMode, string> = {
	ask: "Todo comando e toda escrita de arquivo pedem sua aprovação.",
	allowlist: "Leituras e os comandos da lista rodam direto; o resto pede aprovação.",
	auto: "Roda tudo sem perguntar. Só pede sua aprovação para ações que saem do ambiente ou não têm volta (push na branch principal, publicar, deploy, apagar fora do projeto…).",
};

/** Verificador inteligente: ligado por padrão no modo Automático (`coding.verifier` da conta desliga). */
export const DEFAULT_DEV_VERIFIER_ENABLED = true;
export const DEV_VERIFIER_LABEL = "Verificador inteligente";
export const DEV_VERIFIER_HINT =
	"Antes de cada ação, um modelo rápido confere se ela combina com o que você pediu e se é segura. Bloqueia o que for perigoso e só te pergunta quando tiver dúvida.";

export function isDevApprovalMode(value: unknown): value is DevApprovalMode {
	return typeof value === "string" && (DEV_APPROVAL_MODES as readonly string[]).includes(value);
}

/** Padrões editáveis da lista liberada (executam código do repositório: por isso NÃO são "seguros" embutidos). */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
	"pnpm test",
	"pnpm typecheck",
	"pnpm lint",
	"pnpm build",
	"pnpm install",
	"pnpm run test",
	"pnpm run build",
	"pnpm run lint",
	"pnpm run typecheck",
	"npm test",
	"npm run test",
	"npm run build",
	"npm run lint",
	"npm run typecheck",
	"npm install",
	"npm ci",
	"yarn test",
	"yarn build",
	"yarn lint",
	"yarn install",
	"git add",
	"git commit",
	"git switch",
	"git fetch",
];

export const DEV_COMMAND_ALLOWLIST_MAX = 100;
export const DEV_COMMAND_PREFIX_MAX_CHARS = 120;
export const DEV_COMMAND_PREFIX_MAX_WORDS = 6;

/** Modo efetivo: ambiente > padrão da conta > "Automático". Execução sem humano também fica em "Automático": a ação arriscada falha com mensagem clara em vez de esperar. */
export function resolveApprovalMode(input: {
	env?: DevApprovalMode | null;
	account?: DevApprovalMode | null;
	unattended?: boolean;
}): DevApprovalMode {
	const mode = input.env ?? input.account ?? DEFAULT_DEV_APPROVAL_MODE;
	return mode;
}

// ---------------------------------------------------------------------------
// Análise do comando
// ---------------------------------------------------------------------------

export type CommandSegment = {
	words: string[];
	/** Redireciona saída para um arquivo (fora /dev/null e duplicação de descritor). */
	writesFile: boolean;
	/** Vem de um pipe (`a | b`). */
	pipeBefore: boolean;
};

export type ParsedCommand = { ok: true; segments: CommandSegment[] } | { ok: false; reason: string };

const MAX_DEPTH = 4;
const MAX_SEGMENTS = 60;
const FORBIDDEN_ASSIGNMENTS = new Set(["PATH", "BASH_ENV", "ENV", "IFS", "NODE_OPTIONS", "SHELLOPTS", "PROMPT_COMMAND"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["time", "nohup", "command", "builtin"]);
const CHAR_BACKSLASH = String.fromCharCode(92);

function isSpace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\r";
}

function isAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	if (eq <= 0) return false;
	const name = word.slice(0, eq);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
	return true;
}

/** Posição do `)` que fecha o `$(` aberto em `start` (índice logo após o `(`); respeita aspas. -1 se não fecha. */
function findClosingParen(src: string, start: number): number {
	let depth = 1;
	for (let i = start; i < src.length; i++) {
		const ch = src[i]!;
		if (ch === CHAR_BACKSLASH) {
			i++;
		} else if (ch === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return -1;
			i = end;
		} else if (ch === '"') {
			i++;
			while (i < src.length && src[i] !== '"') {
				if (src[i] === CHAR_BACKSLASH) i++;
				i++;
			}
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function parseInto(src: string, depth: number, out: CommandSegment[]): string | null {
	if (depth > MAX_DEPTH) return "aninhamento demais";
	let words: string[] = [];
	let writes = false;
	let pipeBefore = false;
	let buf = "";
	let hasWord = false;
	let redirect: null | "out" | "in" | "dup" = null;

	const endSegment = (pipeNext: boolean) => {
		if (words.length > 0 || writes) out.push({ words, writesFile: writes, pipeBefore });
		words = [];
		writes = false;
		pipeBefore = pipeNext;
	};
	const flushWord = (): string | null => {
		if (!hasWord) return null;
		const word = buf;
		buf = "";
		hasWord = false;
		if (redirect) {
			if (redirect === "out" && word !== "/dev/null") writes = true;
			redirect = null;
			return null;
		}
		if (words.length === 0 && isAssignment(word)) {
			const name = word.slice(0, word.indexOf("="));
			if (FORBIDDEN_ASSIGNMENTS.has(name.toUpperCase()) || name.toUpperCase().startsWith("LD_")) return "variável de ambiente sensível";
			return null;
		}
		words.push(word);
		return null;
	};
	const substitute = (inner: string): string | null => {
		if (words.length === 0 && !hasWord) return "comando vindo de substituição";
		const err = parseInto(inner, depth + 1, out);
		if (err) return err;
		buf += "$()";
		hasWord = true;
		return null;
	};

	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (isSpace(ch)) {
			const err = flushWord();
			if (err) return err;
			i++;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			const err = flushWord();
			if (err) return err;
			endSegment(false);
			i++;
			continue;
		}
		if (ch === "#" && !hasWord) {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (ch === "&") {
			const err = flushWord();
			if (err) return err;
			if (src[i + 1] === "&") {
				endSegment(false);
				i += 2;
			} else if (src[i + 1] === ">") {
				// &> arquivo
				redirect = "out";
				i += src[i + 2] === ">" ? 3 : 2;
			} else {
				endSegment(false);
				i++;
			}
			continue;
		}
		if (ch === "|") {
			const err = flushWord();
			if (err) return err;
			if (src[i + 1] === "|") {
				endSegment(false);
				i += 2;
			} else if (src[i + 1] === "&") {
				endSegment(true);
				i += 2;
			} else {
				endSegment(true);
				i++;
			}
			continue;
		}
		if (ch === "(" || ch === ")") {
			const err = flushWord();
			if (err) return err;
			endSegment(false);
			i++;
			continue;
		}
		if (ch === ">" || ch === "<") {
			// "2>" / "1>": o descritor numérico não é palavra.
			if (hasWord && /^[0-9]+$/.test(buf) && !redirect) {
				buf = "";
				hasWord = false;
			}
			const err = flushWord();
			if (err) return err;
			const next = src[i + 1];
			if (ch === "<" && next === "<") return "heredoc";
			if (next === "(") return "substituição de processo";
			if (ch === "<") {
				redirect = "in";
				i++;
			} else if (next === "&") {
				redirect = "dup";
				i += 2;
			} else {
				redirect = "out";
				i += next === ">" ? 2 : next === "|" ? 2 : 1;
			}
			continue;
		}
		if (ch === CHAR_BACKSLASH) {
			if (i + 1 >= src.length) return "barra no fim";
			if (src[i + 1] !== "\n") {
				buf += src[i + 1];
				hasWord = true;
			}
			i += 2;
			continue;
		}
		if (ch === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return "aspas abertas";
			buf += src.slice(i + 1, end);
			hasWord = true;
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			i++;
			hasWord = true;
			let closed = false;
			while (i < src.length) {
				const c = src[i]!;
				if (c === '"') {
					closed = true;
					i++;
					break;
				}
				if (c === CHAR_BACKSLASH && i + 1 < src.length) {
					buf += src[i + 1];
					i += 2;
					continue;
				}
				if (c === "$" && src[i + 1] === "(") {
					if (src[i + 2] === "(") return "aritmética";
					const end = findClosingParen(src, i + 2);
					if (end < 0) return "substituição aberta";
					const err = substituteInQuotes(src.slice(i + 2, end));
					if (err) return err;
					i = end + 1;
					continue;
				}
				if (c === "`") {
					const end = src.indexOf("`", i + 1);
					if (end < 0) return "crase aberta";
					const err = substituteInQuotes(src.slice(i + 1, end));
					if (err) return err;
					i = end + 1;
					continue;
				}
				buf += c;
				i++;
			}
			if (!closed) return "aspas abertas";
			continue;
		}
		if (ch === "`") {
			const end = src.indexOf("`", i + 1);
			if (end < 0) return "crase aberta";
			const err = substitute(src.slice(i + 1, end));
			if (err) return err;
			i = end + 1;
			continue;
		}
		if (ch === "$") {
			if (src[i + 1] === "(") {
				if (src[i + 2] === "(") return "aritmética";
				const end = findClosingParen(src, i + 2);
				if (end < 0) return "substituição aberta";
				const err = substitute(src.slice(i + 2, end));
				if (err) return err;
				i = end + 1;
				continue;
			}
			if (src[i + 1] === "{") {
				const end = src.indexOf("}", i + 2);
				if (end < 0) return "expansão aberta";
				const body = src.slice(i, end + 1);
				if (body.includes("$(") || body.includes("`")) return "expansão com comando";
				if (words.length === 0 && !hasWord) return "comando vindo de variável";
				buf += body;
				hasWord = true;
				i = end + 1;
				continue;
			}
			if (words.length === 0 && !hasWord) return "comando vindo de variável";
		}
		buf += ch;
		hasWord = true;
		i++;
	}
	const err = flushWord();
	if (err) return err;
	if (redirect) return "redirecionamento sem destino";
	endSegment(false);
	return null;

	function substituteInQuotes(inner: string): string | null {
		const err = parseInto(inner, depth + 1, out);
		if (err) return err;
		buf += "$()";
		return null;
	}
}

/** Quebra o comando em segmentos (`&&`, `||`, `;`, `|`, `$( )`, subshell) ou diz por que não deu. */
export function parseCommand(cmd: string): ParsedCommand {
	const out: CommandSegment[] = [];
	const text = cmd.trim();
	if (!text) return { ok: false, reason: "comando vazio" };
	const reason = parseInto(text, 0, out);
	if (reason) return { ok: false, reason };
	if (out.length > MAX_SEGMENTS) return { ok: false, reason: "comandos demais" };
	const flat: CommandSegment[] = [];
	for (const segment of out) {
		const expanded = expandSegment(segment, 0);
		if (expanded === null) return { ok: false, reason: "comando não reconhecido" };
		flat.push(...expanded);
	}
	return { ok: true, segments: flat };
}

/** Tira prefixos neutros (`time`, `env A=b`) e abre `bash -c "…"`; `null` = não deu para entender. */
function expandSegment(segment: CommandSegment, depth: number): CommandSegment[] | null {
	let words = segment.words;
	while (words.length > 0) {
		const head = words[0]!;
		if (WRAPPERS.has(head)) {
			words = words.slice(1);
		} else if (head === "env") {
			let k = 1;
			while (k < words.length && isAssignment(words[k]!)) {
				const name = words[k]!.slice(0, words[k]!.indexOf("=")).toUpperCase();
				if (FORBIDDEN_ASSIGNMENTS.has(name) || name.startsWith("LD_")) return null;
				k++;
			}
			words = words.slice(k);
		} else {
			break;
		}
	}
	if (words.length === 0) return [];
	const head = words[0]!;
	if (SHELLS.has(head) && words.length >= 3 && words[1] === "-c") {
		if (depth >= MAX_DEPTH) return null;
		const inner = parseCommand(words[2]!);
		if (!inner.ok) return null;
		return inner.segments.map((s, index) => ({ ...s, pipeBefore: index === 0 ? segment.pipeBefore : s.pipeBefore, writesFile: s.writesFile || segment.writesFile }));
	}
	return [{ ...segment, words }];
}

// ---------------------------------------------------------------------------
// Somente leitura embutido
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS = new Set([
	"ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "tree", "stat", "file", "du", "df", "which", "whoami", "date",
	"uname", "id", "hostname", "uniq", "cut", "tr", "basename", "dirname", "realpath", "readlink", "nl", "tac", "rev", "seq",
	"diff", "cmp", "md5sum", "sha256sum", "sha1sum", "cd", "true", "false", "test", "[", "jq", "sleep", "grep", "egrep", "fgrep",
	"pushd", "popd", ":",
]);
const FIND_UNSAFE = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "rev-list", "ls-tree", "cat-file", "grep"]);
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"]);
const VERSION_FLAGS = new Set(["-v", "-V", "--version", "version"]);
const VERSIONED = new Set(["node", "pnpm", "npm", "yarn", "python", "python3", "git", "go", "cargo", "rustc", "ruby", "java", "deno", "bun"]);

/** Endereço de linha do sed: número, '$' ou /regex/. Devolve o índice logo após ele, ou -1. */
function sedAddressEnd(script: string, start: number): number {
	const first = script[start];
	if (first === "$") return start + 1;
	if (first !== undefined && first >= "0" && first <= "9") {
		let i = start;
		while (i < script.length && script[i]! >= "0" && script[i]! <= "9") i += 1;
		return i;
	}
	if (first === "/") {
		const close = script.indexOf("/", start + 1);
		return close === -1 ? -1 : close + 1;
	}
	return -1;
}

/** Script do 'sed -n' que só imprime: 'ENDEREÇO[,ENDEREÇO]p' (sem 'w', 'e', 's///e', 'r'). */
function isSedPrintScript(script: string): boolean {
	const trimmed = script.trim();
	let i = sedAddressEnd(trimmed, 0);
	if (i === -1) return false;
	if (trimmed[i] === ",") {
		i = sedAddressEnd(trimmed, i + 1);
		if (i === -1) return false;
	}
	return trimmed.slice(i).trim() === "p" || trimmed.slice(i).trim() === "";
}

const SET_SAFE_OPTIONS = new Set(["-e", "-u", "-x", "-eu", "-ex", "-ux", "-eux", "+e", "+u", "+x", "-o", "+o", "pipefail", "errexit", "nounset", "xtrace", "-euo", "-eo"]);

/** 'sed -n 'ENDEREÇO,ENDEREÇOp' [arquivo…]': lê e imprime; '-i'/'--in-place', '-f', '-e' e 'w'/'e' ficam de fora. */
function isReadOnlySed(args: string[]): boolean {
	let quiet = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (arg === "-n" || arg === "--quiet" || arg === "--silent") quiet = true;
		else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended" || arg === "-s" || arg === "--separate") continue;
		else if (arg.startsWith("-") && arg.length > 1) return false;
		else positional.push(arg);
	}
	return quiet && positional.length >= 1 && isSedPrintScript(positional[0]!);
}

/** Comandos de shell sem efeito: 'export VAR=x', 'set -e', 'set -o pipefail', 'env' puro, 'command -v x'. */
function isHarmlessShellBuiltin(cmd: string, args: string[]): boolean {
	if (cmd === "env") return args.length === 0;
	// "command" é descascado pelo analisador: "command -v node" chega como ["-v", "node"].
	if ((cmd === "-v" || cmd === "-V") && args.length >= 1) return args.every((a) => !a.startsWith("-"));
	if (cmd === "export") return args.every((a) => /^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/.test(a) && !a.includes("$()"));
	if (cmd === "set") return args.length > 0 && args.every((a) => SET_SAFE_OPTIONS.has(a));
	return false;
}

/** Comando que só lê (sem escrever arquivo nem executar código arbitrário). */
export function isReadOnlySegment(segment: CommandSegment): boolean {
	if (segment.writesFile) return false;
	const [cmd, ...args] = segment.words;
	if (!cmd) return true;
	if (VERSIONED.has(cmd) && args.length === 1 && VERSION_FLAGS.has(args[0]!)) return true;
	if (READ_ONLY_COMMANDS.has(cmd)) return true;
	if (cmd === "rg") return !args.some((a) => a === "--pre" || a.startsWith("--pre=") || a === "--pre-glob" || a.startsWith("--pre-glob="));
	if (cmd === "sort") return !args.some((a) => a === "-o" || a.startsWith("--output") || (a.startsWith("-") && !a.startsWith("--") && a.includes("o")));
	if (cmd === "find") return !args.some((a) => FIND_UNSAFE.has(a));
	if (cmd === "sed") return isReadOnlySed(args);
	if (isHarmlessShellBuiltin(cmd, args)) return true;
	if (cmd === "git") return isReadOnlyGit(args);
	return false;
}

function isReadOnlyGit(argsIn: string[]): boolean {
	let args = argsIn;
	for (;;) {
		if (args[0] === "--no-pager") args = args.slice(1);
		else if (args[0] === "-C" && args.length > 2) args = args.slice(2);
		else break;
	}
	const sub = args[0];
	if (!sub) return false;
	const rest = args.slice(1);
	if (rest.some((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff")) return false;
	if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
	if (sub === "branch") return rest.every((a) => GIT_BRANCH_FLAGS.has(a));
	if (sub === "tag") return rest.length === 0 || rest.every((a) => a === "-l" || a === "--list");
	if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
	if (sub === "stash") return rest.length === 1 && rest[0] === "list";
	return false;
}

// ---------------------------------------------------------------------------
// Bloqueio fixo (sempre pergunta, até no modo Automático)
// ---------------------------------------------------------------------------

const DANGEROUS_RM_TARGETS = new Set([
	"/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "$HOME/*", ".", "..", "*", "./*", "/home", "/root", "/etc", "/usr", "/var", "/bin", "/boot", "/workspace", "/workspace/*",
]);
const PROTECTED_BRANCH = /^\+?(HEAD:)?(refs\/heads\/)?(main|master|trunk|develop|production)$/;
const HARD_DENY_RAW: Array<[RegExp, string]> = [
	[/(curl|wget)[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh/, "baixa e executa um script (curl | sh)"],
	[/(ba|z|da)?sh\s+<\(\s*(curl|wget)/, "baixa e executa um script"],
	[/:\(\)\s*\{/, "fork bomb"],
	[/>\s*\/dev\/(sd|nvme|vd|hd)/, "escreve direto em disco"],
];

function isRecursiveFlag(word: string): boolean {
	if (word === "--recursive") return true;
	return word.startsWith("-") && !word.startsWith("--") && (word.includes("r") || word.includes("R"));
}

/** Motivo do bloqueio fixo de um segmento, ou `null`. */
function hardDenySegment(segment: CommandSegment, previous: CommandSegment | undefined): string | null {
	const [cmd, ...args] = segment.words;
	if (!cmd) return null;
	if (cmd === "sudo" || cmd === "su" || cmd === "doas") return "executa como administrador";
	if (cmd === "rm" && args.some(isRecursiveFlag) && args.some((a) => DANGEROUS_RM_TARGETS.has(a))) return "apaga a raiz, a home ou o workspace inteiro";
	if (cmd === "git") {
		const at = segment.words.indexOf("push");
		if (at > 0 && at <= 4) {
			const pushArgs = segment.words.slice(at + 1);
			if (pushArgs.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-") || a === "--delete" || a === "-d")) return "force push ou apagar branch remota";
			if (pushArgs.some((a) => PROTECTED_BRANCH.test(a) || (a.startsWith(":") && PROTECTED_BRANCH.test(a.slice(1))))) return "push direto para a branch principal";
		}
	}
	if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && args[0] === "publish") return "publica um pacote";
	if (cmd === "gh" && ((args[0] === "repo" && args[1] === "delete") || (args[0] === "pr" && args[1] === "merge") || (args[0] === "release" && args[1] === "delete"))) return "ação irreversível no GitHub";
	if (cmd === "dd" && args.some((a) => a.startsWith("of=/dev/"))) return "escreve direto em disco";
	if (cmd.startsWith("mkfs") || cmd === "fdisk" || cmd === "shred" || cmd === "shutdown" || cmd === "reboot" || cmd === "halt" || cmd === "poweroff") return "mexe no sistema";
	if ((cmd === "chmod" || cmd === "chown") && args.some(isRecursiveFlag) && args.some((a) => a === "/" || a === "/*")) return "muda permissões da raiz";
	if (segment.pipeBefore && previous && (previous.words[0] === "curl" || previous.words[0] === "wget") && (SHELLS.has(cmd) || cmd === "python" || cmd === "python3" || cmd === "node" || cmd === "perl" || cmd === "ruby")) {
		return "baixa e executa um script (curl | sh)";
	}
	return null;
}

/** Bloqueio fixo do comando inteiro (também quando a análise falhou, pelo texto cru). */
export function hardDenyReason(cmd: string, parsed?: ParsedCommand): string | null {
	for (const [pattern, reason] of HARD_DENY_RAW) if (pattern.test(cmd)) return reason;
	const result = parsed ?? parseCommand(cmd);
	if (!result.ok) return null;
	for (let i = 0; i < result.segments.length; i++) {
		const reason = hardDenySegment(result.segments[i]!, result.segments[i - 1]);
		if (reason) return reason;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Ações "para fora" ou sem volta (perguntam até no modo Automático)
// Só texto e palavras já separadas pela análise (sem regex frágil).
// ---------------------------------------------------------------------------

const RUNNER_HEADS = new Set(["npx", "bunx", "pnpx"]);
const PM_HEADS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PM_EXEC = new Set(["exec", "dlx", "x"]);
const OUTWARD_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_ROOTS = ["/workspace", "/tmp"];
/** Build e compose rodam dentro do ambiente e vão direto ao Verificador, sem serem "arriscados" por regra. */
const DOCKER_LOCAL = new Set(["build", "buildx", "compose"]);
const DOCKER_READ = new Set(["ps", "images", "logs", "version", "inspect", "info", "--version", "-v", "help"]);
const KUBECTL_READ = new Set(["get", "describe", "logs", "version", "config", "api-resources", "explain", "top", "--version", "help"]);

/** Tira `npx`, `pnpm exec`, `pnpm dlx`… para chegar na ferramenta de verdade. */
function stripRunners(wordsIn: readonly string[]): string[] {
	let words = [...wordsIn];
	for (let guard = 0; guard < 4 && words.length > 0; guard++) {
		const head = words[0]!;
		let skip = 0;
		if (RUNNER_HEADS.has(head)) skip = 1;
		else if (PM_HEADS.has(head) && words[1] !== undefined && PM_EXEC.has(words[1])) skip = 2;
		if (skip === 0) break;
		words = words.slice(skip);
		while (words.length > 0 && words[0]!.startsWith("-")) words = words.slice(1);
	}
	return words;
}

/** Palavras que não são opções. */
function positionals(args: readonly string[]): string[] {
	return args.filter((a) => !a.startsWith("-"));
}

function underSafeRoot(path: string): boolean {
	return SAFE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function isInsideSafeRoot(path: string, cwd: string): boolean {
	if (path === "" || path.startsWith("~") || path.includes("$") || path.split("/").includes("..")) return false;
	if (path.startsWith("/")) return underSafeRoot(path);
	return underSafeRoot(cwd); // relativo: vale o diretório de trabalho da chamada
}

function mentionsOutsidePath(args: readonly string[], cwd: string): boolean {
	return positionals(args).some((a) => !isInsideSafeRoot(a, cwd));
}

/** Motivo de `git push` perguntar, ou `null` (push de branch de trabalho explícita roda). */
function gitPushRisk(words: readonly string[]): string | null {
	let i = 1;
	while (i < words.length) {
		const w = words[i]!;
		if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree") i += 2;
		else if (w.startsWith("-")) i += 1;
		else break;
	}
	if (words[i] !== "push") return null;
	const rest = words.slice(i + 1);
	if (rest.some((a) => a === "--all" || a === "--mirror" || a === "--tags" || a === "--prune")) return "git push de várias referências de uma vez";
	const pos: string[] = [];
	for (let k = 0; k < rest.length; k++) {
		const a = rest[k]!;
		if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack" || a === "--exec") k++;
		else if (!a.startsWith("-")) pos.push(a);
	}
	const refspecs = pos.slice(1);
	if (refspecs.length === 0) return "git push sem branch explícita (pode ser a branch principal)";
	for (const spec of refspecs) {
		if (spec.startsWith(":")) return "apaga branch remota";
		const dest = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
		if (dest === "" || dest === "HEAD" || dest === "@") return "git push sem branch de destino explícita (pode ser a branch principal)";
	}
	return null;
}

const CURL_UPLOAD = "curl enviando dados para fora";
const CURL_METHOD = "curl com método que altera algo no servidor";
const WGET_UPLOAD = "wget enviando dados para fora";

function curlRisk(args: readonly string[]): string | null {
	for (let k = 0; k < args.length; k++) {
		const a = args[k]!;
		const next = (args[k + 1] ?? "").toUpperCase();
		if (a === "-X" || a === "--request") {
			if (OUTWARD_METHODS.has(next)) return CURL_METHOD;
		} else if (a.startsWith("--request=")) {
			if (OUTWARD_METHODS.has(a.slice("--request=".length).toUpperCase())) return CURL_METHOD;
		} else if (a.startsWith("--")) {
			if (a === "--json" || a === "--upload-file" || a === "--form" || a.startsWith("--form-string") || a.startsWith("--data")) return CURL_UPLOAD;
		} else if (a.startsWith("-") && a.length >= 2) {
			const flags = a.slice(1);
			if (flags.includes("d") || flags.includes("F") || flags.includes("T")) return CURL_UPLOAD;
			const x = flags.indexOf("X");
			if (x >= 0) {
				const inline = flags.slice(x + 1);
				if (OUTWARD_METHODS.has((inline || next).toUpperCase())) return CURL_METHOD;
			}
		}
	}
	return null;
}

function wgetRisk(args: readonly string[]): string | null {
	for (let k = 0; k < args.length; k++) {
		const a = args[k]!;
		if (a.startsWith("--post-data") || a.startsWith("--post-file") || a.startsWith("--body-data") || a.startsWith("--body-file")) return WGET_UPLOAD;
		if (a.startsWith("--method=") && OUTWARD_METHODS.has(a.slice("--method=".length).toUpperCase())) return WGET_UPLOAD;
		if (a === "--method" && OUTWARD_METHODS.has((args[k + 1] ?? "").toUpperCase())) return WGET_UPLOAD;
	}
	return null;
}

function ghApiRisk(args: readonly string[]): string | null {
	const reason = "chamada gh api que altera algo no GitHub";
	let method: string | null = null;
	let hasFields = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k]!;
		if (a === "-X" || a === "--method") method = args[k + 1] ?? "";
		else if (a.startsWith("--method=")) method = a.slice("--method=".length);
		else if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") hasFields = true;
	}
	if (method !== null) return method.toUpperCase() === "GET" ? null : reason;
	return hasFields ? reason : null; // campos fazem o gh api virar POST sozinho
}

function findRisk(args: readonly string[], cwd: string): string | null {
	if (!args.includes("-delete")) return null;
	const starts: string[] = [];
	for (const a of args) {
		if (a.startsWith("-") || a === "(" || a === "!") break;
		starts.push(a);
	}
	const targets = starts.length === 0 ? ["."] : starts;
	return targets.some((t) => !isInsideSafeRoot(t, cwd)) ? "apaga arquivos recursivamente fora do projeto" : null;
}

function segmentRisk(segment: CommandSegment, cwd: string): string | null {
	const words = stripRunners(segment.words);
	const [cmd, ...args] = words;
	if (!cmd) return null;
	const pos = positionals(args);
	switch (cmd) {
		case "git":
			return gitPushRisk(words);
		case "gh": {
			const [a, b] = pos;
			if (a === "pr" && (b === "merge" || b === "close")) return "mexe num pull request no GitHub";
			if (a === "release" && (b === "create" || b === "delete" || b === "edit")) return "publica ou altera uma release";
			if (a === "repo" && (b === "delete" || b === "edit" || b === "archive" || b === "rename")) return "altera ou apaga o repositório no GitHub";
			if (a === "api") return ghApiRisk(args);
			return null;
		}
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return pos[0] === "publish" || (cmd === "yarn" && pos[0] === "npm" && pos[1] === "publish") ? "publica um pacote" : null;
		case "docker":
		case "podman":
			return pos[0] === undefined || DOCKER_READ.has(pos[0]) || DOCKER_LOCAL.has(pos[0]) ? null : "comando de contêiner (docker)";
		case "kubectl":
		case "helm":
			return pos[0] === undefined || KUBECTL_READ.has(pos[0]) ? null : "altera um cluster (kubectl)";
		case "terraform":
		case "tofu":
			return pos[0] === "apply" || pos[0] === "destroy" ? "altera ou destrói infraestrutura (terraform)" : null;
		case "vercel":
			return "deploy (vercel)";
		case "netlify":
			return pos[0] === "deploy" ? "deploy (netlify)" : null;
		case "fly":
		case "flyctl":
			return pos[0] === "deploy" ? "deploy (fly)" : null;
		case "railway":
			return pos[0] === "up" ? "deploy (railway)" : null;
		case "wrangler":
			return pos[0] === "deploy" || pos[0] === "publish" ? "deploy (wrangler)" : null;
		case "curl":
			return curlRisk(args);
		case "wget":
			return wgetRisk(args);
		case "rm":
			return args.some(isRecursiveFlag) && mentionsOutsidePath(args, cwd) ? "apaga arquivos recursivamente fora do projeto" : null;
		case "find":
			return findRisk(args, cwd);
		case "chmod":
		case "chown":
			return args.some(isRecursiveFlag) && mentionsOutsidePath(args, cwd) ? "muda permissões recursivamente fora do projeto" : null;
		case "psql":
		case "mysql":
		case "mariadb":
		case "sqlite3": {
			const text = args.join(" ").toUpperCase();
			return text.includes("DROP DATABASE") || text.includes("DROP TABLE") || text.includes("DROP SCHEMA") || text.includes("TRUNCATE") ? "apaga dados de um banco" : null;
		}
		case "prisma":
			if (pos[0] === "migrate" && pos[1] === "reset") return "apaga o banco (prisma migrate reset)";
			if (pos[0] === "db" && pos[1] === "push" && (args.includes("--force-reset") || args.includes("--accept-data-loss"))) return "apaga dados do banco (prisma db push)";
			return null;
		default:
			return null;
	}
}

const RISK_HEADS = new Set(["git", "gh", "npm", "pnpm", "yarn", "bun", "docker", "podman", "kubectl", "helm", "terraform", "tofu", "vercel", "netlify", "fly", "flyctl", "railway", "wrangler", "curl", "wget", "rm", "find", "chmod", "chown", "psql", "mysql", "mariadb", "sqlite3", "prisma"]);
/** Separam comandos dentro de um texto que o analisador não entende (heredoc, `$(…)`, `bash -c "…"`). */
const HIDDEN_SPLIT_CHARS = new Set([";", "|", "&", "(", ")", "`", "'", '"', "{", "}", String.fromCharCode(10)]);
const HIDDEN_SPACE_CHARS = new Set([" ", String.fromCharCode(9), String.fromCharCode(13)]);

/**
 * Comando que não dá para analisar: procura, de forma tolerante, uma ação arriscada escondida dentro dele
 * (script, heredoc, substituição). Pode dar falso positivo; aí só pergunta, nunca bloqueia.
 */
function hiddenRiskReason(cmd: string, cwd: string): string | null {
	const chunks: string[][] = [];
	let words: string[] = [];
	let word = "";
	const flushWord = () => {
		if (word) words.push(word);
		word = "";
	};
	for (const ch of cmd) {
		if (HIDDEN_SPLIT_CHARS.has(ch)) {
			flushWord();
			if (words.length) chunks.push(words);
			words = [];
		} else if (HIDDEN_SPACE_CHARS.has(ch)) flushWord();
		else word += ch;
	}
	flushWord();
	if (words.length) chunks.push(words);
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			if (!RISK_HEADS.has(chunk[i]!)) continue;
			const reason = segmentRisk({ words: chunk.slice(i), writesFile: false, pipeBefore: false }, cwd);
			if (reason) return `${reason} (escondido num trecho que não consegui analisar por completo, como script, heredoc ou substituição de comando; confira o comando inteiro antes de executar)`;
		}
	}
	return null;
}

/** Motivo de a ação ser "para fora" ou sem volta (pergunta até no modo Automático), ou `null`. Comando que não dá para analisar só pergunta se esconder uma ação dessas. */
export function riskyReason(cmd: string, parsed?: ParsedCommand, cwd = "/workspace"): string | null {
	const result = parsed ?? parseCommand(cmd);
	if (!result.ok) return hiddenRiskReason(cmd, cwd);
	for (const segment of result.segments) {
		const reason = segmentRisk(segment, cwd);
		if (reason) return reason;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Lista liberada por prefixo
// ---------------------------------------------------------------------------

const REJECTED_PREFIX_HEADS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "exec", "env", "xargs", "sudo", "su", "doas"]);

/** Prefixo digitado → palavras normalizadas (`null` = inválido). Entradas amplas demais (bash, sudo, eval…) são recusadas. */
export function normalizeCommandPrefix(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim().replace(/\s+/g, " ");
	if (!text || text.length > DEV_COMMAND_PREFIX_MAX_CHARS) return null;
	const parsed = parseCommand(text);
	if (!parsed.ok || parsed.segments.length !== 1) return null;
	const segment = parsed.segments[0]!;
	if (segment.writesFile || segment.words.length === 0 || segment.words.length > DEV_COMMAND_PREFIX_MAX_WORDS) return null;
	if (text.includes("$(") || text.includes("`")) return null;
	if (REJECTED_PREFIX_HEADS.has(segment.words[0]!) || hardDenySegment(segment, undefined)) return null;
	return segment.words.join(" ");
}

/** Programas que mandam dados para fora ou mexem em infraestrutura: o agente não pode liberá-los sozinho. */
const AGENT_NEVER_ALLOW_HEADS = new Set(["curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "socat", "gh", "aws", "gcloud", "az", "kubectl", "terraform", "rm", "dd", "mkfs", "chmod", "chown"]);

/** O agente pode propor este prefixo para a lista liberada? Nada que saia do ambiente ou não tenha volta (no Automático a lista dispensa o Verificador). */
export function agentMayAllowPrefix(prefix: string): boolean {
	const head = prefix.split(" ")[0] ?? "";
	if (AGENT_NEVER_ALLOW_HEADS.has(head)) return false;
	if (head === "git" && prefix.split(" ")[1] === "push") return false;
	return riskyReason(prefix) === null;
}

/** Lista de prefixos do usuário, normalizada e sem repetição; inválidos viram erro. */
export function parseCommandAllowlist(raw: unknown): { value: string[]; error?: never } | { value?: never; error: string } {
	if (raw === undefined || raw === null) return { value: [] };
	if (!Array.isArray(raw)) return { error: "commandAllowlist deve ser uma lista de comandos" };
	if (raw.length > DEV_COMMAND_ALLOWLIST_MAX) return { error: `No máximo ${DEV_COMMAND_ALLOWLIST_MAX} comandos liberados` };
	const out: string[] = [];
	for (const item of raw) {
		const prefix = normalizeCommandPrefix(item);
		if (!prefix) return { error: `Comando inválido: ${typeof item === "string" ? item.slice(0, 60) : "?"}` };
		if (!out.includes(prefix)) out.push(prefix);
	}
	return { value: out };
}

/** Separa texto digitado (um prefixo por linha ou vírgula) em válidos e inválidos. */
export function addCommandPrefixes(current: readonly string[], text: string): { list: string[]; error: string | null } {
	const list = [...current];
	let error: string | null = null;
	for (const part of text.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean)) {
		const prefix = normalizeCommandPrefix(part);
		if (!prefix) {
			error ??= `Comando inválido: ${part.slice(0, 40)}`;
			continue;
		}
		if (!list.includes(prefix) && list.length < DEV_COMMAND_ALLOWLIST_MAX) list.push(prefix);
	}
	return { list, error };
}

function matchesPrefix(words: readonly string[], prefix: string): boolean {
	const tokens = prefix.split(" ");
	if (tokens.length > words.length) return false;
	return tokens.every((token, index) => words[index] === token);
}

const SUBCOMMAND_TOOLS = new Set(["git", "pnpm", "npm", "yarn", "bun", "cargo", "go", "gh", "pip", "pip3", "uv", "make", "docker", "composer", "dotnet", "mvn", "gradle", "deno", "npx"]);
const RUNNER_TOOLS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNER_SUBCOMMANDS = new Set(["run", "exec", "dlx", "x"]);
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "deno", "bun"]);
const WORD_LIKE = /^[a-z][a-z0-9:_-]*$/i;

/** Prefixo sugerido para "Sempre permitir" (`null` = não oferecer). */
export function suggestCommandPrefix(words: readonly string[]): string | null {
	const [head] = words;
	if (!head || REJECTED_PREFIX_HEADS.has(head)) return null;
	// npx -y pacote ...: as flags de confirmação não contam como o subcomando.
	if (head === "npx") {
		const rest = words.slice(1).filter((w) => w !== "-y" && w !== "--yes" && w !== "--no-install");
		return rest[0] && WORD_LIKE.test(rest[0]) ? `npx ${rest[0]}` : null;
	}
	const [, second, third] = words;
	if (INTERPRETERS.has(head)) {
		if (second && !second.startsWith("-") && second.length <= 60 && !SHELLS.has(head)) return `${head} ${second}`;
		return null;
	}
	if (SUBCOMMAND_TOOLS.has(head) && second && WORD_LIKE.test(second)) {
		if (RUNNER_TOOLS.has(head) && RUNNER_SUBCOMMANDS.has(second)) return third && WORD_LIKE.test(third) ? `${head} ${second} ${third}` : null;
		return `${head} ${second}`;
	}
	// git/pnpm/npm/... sem subcomando claro (flags primeiro): o nome sozinho liberaria tudo da ferramenta.
	if (SUBCOMMAND_TOOLS.has(head)) return null;
	if (head.includes("/") || !/^[A-Za-z0-9._+-]+$/.test(head)) return null;
	return head;
}

export type DevCommandDecision =
	| {
			action: "run";
			/** Liberado por um prefixo da lista do repositório (o Verificador nem é chamado; bloqueio fixo vale antes). */
			via?: "allowlist";
	  }
	| {
			action: "ask";
			reason: "mode" | "hard-deny" | "risky" | "not-allowed" | "unparseable" | "sensitive-read";
			/** Texto curto para o card. */
			detail?: string;
			/** Prefixos de "Sempre permitir" (vazio = sem o botão). */
			prefixes: string[];
	  };

/** Decide se o comando roda direto ou pede aprovação. */
export function decideCommand(input: { cmd: string; mode: DevApprovalMode; allowlist: readonly string[]; cwd?: string }): DevCommandDecision {
	const parsed = parseCommand(input.cmd);
	const denied = hardDenyReason(input.cmd, parsed);
	if (denied) return { action: "ask", reason: "hard-deny", detail: denied, prefixes: [] };
	if (input.mode !== "ask") {
		const envRead = sensitiveReadReason(input.cmd);
		if (envRead) return { action: "ask", reason: "sensitive-read", detail: envRead, prefixes: [] };
	}
	if (input.mode === "auto") {
		// Bloqueio fixo e ações de risco (sair do ambiente, sem volta) perguntam sempre; a lista não os libera.
		const risky = riskyReason(input.cmd, parsed, input.cwd);
		if (risky) return { action: "ask", reason: "risky", detail: risky, prefixes: [] };
		// A lista do repositório vale também no Automático ("Sempre neste repositório"): o comando roda sem passar pelo Verificador.
		if (parsed.ok && allowlistCovers(parsed.segments, input.allowlist)) return { action: "run", via: "allowlist" };
		return { action: "run" };
	}
	if (!parsed.ok) return { action: "ask", reason: input.mode === "ask" ? "mode" : "unparseable", detail: parsed.reason, prefixes: [] };
	if (input.mode === "ask") return { action: "ask", reason: "mode", prefixes: suggestAll(parsed.segments, input.allowlist, false) };
	const unmatched = unmatchedSegments(parsed.segments, input.allowlist);
	if (unmatched.length === 0) return { action: "run" };
	return { action: "ask", reason: "not-allowed", prefixes: suggestAll(unmatched, input.allowlist, true) };
}

function unmatchedSegments(segments: readonly CommandSegment[], allowlist: readonly string[]): CommandSegment[] {
	return segments.filter((s) => (s.words.length > 0 || s.writesFile) && !isReadOnlySegment(s) && !allowlist.some((p) => matchesPrefix(s.words, p)));
}

/** Todo trecho que não é só leitura bate com a lista, e pelo menos um bate (senão não foi a lista que liberou). */
function allowlistCovers(segments: readonly CommandSegment[], allowlist: readonly string[]): boolean {
	if (allowlist.length === 0 || unmatchedSegments(segments, allowlist).length > 0) return false;
	return segments.some((s) => s.words.length > 0 && !isReadOnlySegment(s) && allowlist.some((p) => matchesPrefix(s.words, p)));
}

/** Prefixos de "Sempre neste repositório" para o comando (vazio = não oferecer). */
export function suggestPrefixesForCommand(cmd: string, allowlist: readonly string[] = []): string[] {
	const parsed = parseCommand(cmd);
	if (!parsed.ok) return [];
	return suggestAll(unmatchedSegments(parsed.segments, allowlist), allowlist, true);
}

function suggestAll(segments: readonly CommandSegment[], allowlist: readonly string[], onlyUnmatched: boolean): string[] {
	const out: string[] = [];
	for (const segment of segments) {
		if (segment.words.length === 0) {
			if (segment.writesFile) return [];
			continue;
		}
		if (isReadOnlySegment(segment)) continue;
		if (!onlyUnmatched && allowlist.some((p) => matchesPrefix(segment.words, p))) continue;
		const prefix = suggestCommandPrefix(segment.words);
		if (!prefix) return [];
		if (!out.includes(prefix)) out.push(prefix);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Leitura de .env (segredos): pergunta antes, em qualquer modo que não seja "Perguntar sempre" (esse já pergunta tudo)
// ---------------------------------------------------------------------------

const ENV_EXAMPLE_SUFFIXES = new Set(["example", "sample", "template"]);
/** Programas que mostram ou repassam o conteúdo de um arquivo dado como argumento. */
const ENV_READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "gawk", "bat", "nl", "tac", "strings", "xxd", "od", "hexdump", "sort", "uniq", "cut", "diff", "base64", "jq", "yq", "tee", "paste", "column", "fold", "rev", "view", "vi", "vim", "nano"]);

/** .env ou .env.* (exceto .example, .sample e .template), em qualquer pasta. */
export function isSensitiveEnvFile(path: string): boolean {
	const name = (path.split("/").pop() ?? "").toLowerCase();
	if (name === ".env") return true;
	if (!name.startsWith(".env.")) return false;
	return !ENV_EXAMPLE_SUFFIXES.has(name.split(".").pop() ?? "");
}

/** Argumento que aponta para um .env (inclui glob como .env*, que expande para ele, e --flag=.env). */
function isEnvArgument(token: string): boolean {
	let value = token;
	if (value.startsWith("-")) {
		const eq = value.indexOf("=");
		if (eq < 0) return false;
		value = value.slice(eq + 1);
	}
	if (isSensitiveEnvFile(value)) return true;
	const name = (value.split("/").pop() ?? "").toLowerCase();
	return name.startsWith(".env") && (name.includes("*") || name.includes("?")) && !ENV_EXAMPLE_SUFFIXES.has(name.split(".").pop() ?? "");
}

/** Quebra o comando em trechos (por ; | & parênteses crase e quebra de linha) e palavras (espaço, tab, < e >), respeitando aspas. */
function tokenizePieces(cmd: string): string[][] {
	const pieces: string[][] = [];
	let tokens: string[] = [];
	let current = "";
	let quote = "";
	const separators = new Set([";", "|", "&", "(", ")", String.fromCharCode(96), String.fromCharCode(10)]);
	const blanks = new Set([" ", String.fromCharCode(9), String.fromCharCode(13), "<", ">"]);
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};
	const endPiece = () => {
		flush();
		if (tokens.length) pieces.push(tokens);
		tokens = [];
	};
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) quote = "";
			else current += ch;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (blanks.has(ch)) flush();
		else if (separators.has(ch)) endPiece();
		else current += ch;
	}
	endPiece();
	return pieces;
}

/** Motivo de o comando ler um .env (cat .env, grep KEY .env.local, head < .env...); `null` se não lê. */
export function sensitiveReadReason(cmd: string): string | null {
	for (const tokens of tokenizePieces(cmd)) {
		// Atribuições antes do programa (FOO=1 cat .env) não contam como o programa.
		const rest = tokens.filter((t, i) => !(i === 0 && t.includes("=") && !t.startsWith("-")));
		const program = (rest[0] ?? "").split("/").pop() ?? "";
		if (!ENV_READERS.has(program)) continue;
		const hit = rest.slice(1).find(isEnvArgument);
		if (hit) return `lê o arquivo ${hit}, que costuma guardar segredos`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Caminho rápido do Verificador (sem chamada ao modelo)
// ---------------------------------------------------------------------------

const FAST_PATH_PREFIXES: readonly string[] = [...DEFAULT_COMMAND_ALLOWLIST, "git status", "git diff", "git log", "git branch"];
const GIT_BRANCH_DESTRUCTIVE = new Set(["-d", "-D", "--delete", "-f", "--force", "-m", "-M", "--move", "-c", "-C", "--copy"]);

/** Comando de desenvolvimento comum e sem efeito para fora (instalar, compilar, testar, lint, typecheck, git local). */
export function isPlainlySafeDevSegment(segment: CommandSegment): boolean {
	if (segment.writesFile) return false;
	const [head, ...rest] = segment.words;
	if (head === "git" && rest[0] === "branch" && rest.slice(1).some((a) => GIT_BRANCH_DESTRUCTIVE.has(a))) return false;
	return FAST_PATH_PREFIXES.some((prefix) => matchesPrefix(segment.words, prefix));
}

/** Só lê ou só faz coisa comum de desenvolvimento: o Verificador nem é chamado. */
export function isFastPathCommand(cmd: string, parsed?: ParsedCommand): boolean {
	const result = parsed ?? parseCommand(cmd);
	if (!result.ok) return false;
	return result.segments.every((segment) => (segment.words.length === 0 && !segment.writesFile) || isReadOnlySegment(segment) || isPlainlySafeDevSegment(segment));
}

const SENSITIVE_PATH_PARTS = [".github", ".gitlab", ".circleci", ".husky", ".git", ".ssh", ".aws", ".docker", ".kube", ".vscode"];
const SENSITIVE_NAME_HINTS = [".env", ".npmrc", ".yarnrc", ".netrc", "dockerfile", "docker-compose", "compose.y", ".pem", ".key", "id_rsa", "id_ed25519", "credential", "secret", "auth", "permission", "package.json", "pnpm-workspace", "vercel.json", "wrangler.", "netlify.toml", "fly.toml", "railway.", "gitlab-ci", "jenkinsfile", "codeowners"];
const WEAKENING_TEXT_HINTS = ["--no-verify", "chmod 777", "chmod -r 777", "continue-on-error", "@ts-nocheck", ".skip(", "xit(", "xdescribe(", "| sh", "| bash", "base64 -d", "curl ", "wget "];

/**
 * Escrita que o Verificador deve julgar: caminho sensível (CI, autenticação, permissões, segredos, deploy, fora do projeto)
 * ou texto que afrouxa checagens ou parece levar segredo. Edição comum de código do projeto segue direto (latência e custo).
 */
export function isSensitiveWrite(path: string, text: string, redactedText?: string): boolean {
	const lower = path.toLowerCase();
	const parts = lower.split("/").filter(Boolean);
	if (parts.includes("..") || lower.startsWith("~")) return true;
	if (lower.startsWith("/") && !underSafeRoot(lower)) return true;
	if (parts.some((part) => SENSITIVE_PATH_PARTS.includes(part))) return true;
	const name = parts[parts.length - 1] ?? "";
	if (SENSITIVE_NAME_HINTS.some((hint) => name.includes(hint))) return true;
	const body = text.toLowerCase();
	if (WEAKENING_TEXT_HINTS.some((hint) => body.includes(hint))) return true;
	return redactedText !== undefined && redactedText !== text;
}

/** Rótulo do botão "Sempre neste repositório" (vazio = sem o botão). */
export function alwaysAllowLabel(prefixes: readonly string[]): string {
	return prefixes.length === 0 ? "" : "Sempre neste repositório";
}

/** O que "Sempre neste repositório" vai liberar, para mostrar junto do botão. */
export function alwaysAllowDetail(prefixes: readonly string[]): string {
	return prefixes.length === 0 ? "" : `Libera: ${prefixes.join(", ")}`;
}

/** Escrita de arquivo: só o modo "Perguntar sempre" pede aprovação. */
export function writeNeedsApproval(mode: DevApprovalMode): boolean {
	return mode === "ask";
}

// ---------------------------------------------------------------------------
// Cartão de aprovação (dados que a UI mostra) e tokens do protocolo
// ---------------------------------------------------------------------------

export const DEV_APPROVAL_COMMAND_MAX_CHARS = 8_000;
export const DEV_APPROVAL_PREVIEW_MAX_CHARS = 4_000;

export type DevApprovalCardInfo =
	| {
			kind: "command";
			command: string;
			cwd: string;
			repo?: string;
			branch?: string;
			/** Por que está perguntando (modo, bloqueio fixo, não está na lista…). */
			reason?: string;
			/** Prefixos de "Sempre permitir" (vazio = sem o botão). */
			prefixes?: string[];
	  }
	| {
			kind: "write";
			path: string;
			/** Linhas do diff (`+`/`-`) já limitadas. */
			preview: string;
			added: number;
			removed: number;
			created?: boolean;
			/** Por que está perguntando (hoje: parecer do Verificador). */
			reason?: string;
			repo?: string;
			branch?: string;
	  };

function str(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Valida o que vem do evento/banco (nunca confia no formato). */
export function parseDevApprovalInfo(raw: unknown): DevApprovalCardInfo | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const row = raw as Record<string, unknown>;
	const repo = str(row.repo, 200);
	const branch = str(row.branch, 200);
	if (row.kind === "command") {
		const command = str(row.command, DEV_APPROVAL_COMMAND_MAX_CHARS);
		if (!command) return undefined;
		const prefixes = Array.isArray(row.prefixes) ? row.prefixes.filter((p): p is string => typeof p === "string").slice(0, 6).map((p) => p.slice(0, DEV_COMMAND_PREFIX_MAX_CHARS)) : [];
		const reason = str(row.reason, 200);
		return {
			kind: "command",
			command,
			cwd: str(row.cwd, 1_000) ?? "/workspace",
			...(repo ? { repo } : {}),
			...(branch ? { branch } : {}),
			...(reason ? { reason } : {}),
			...(prefixes.length ? { prefixes } : {}),
		};
	}
	if (row.kind === "write") {
		const path = str(row.path, 1_000);
		if (!path) return undefined;
		return {
			kind: "write",
			path,
			preview: typeof row.preview === "string" ? row.preview.slice(0, DEV_APPROVAL_PREVIEW_MAX_CHARS) : "",
			added: typeof row.added === "number" ? row.added : 0,
			removed: typeof row.removed === "number" ? row.removed : 0,
			...(row.created === true ? { created: true } : {}),
			...(str(row.reason, 200) ? { reason: str(row.reason, 200) } : {}),
			...(repo ? { repo } : {}),
			...(branch ? { branch } : {}),
		};
	}
	return undefined;
}

/** Botão "Recusar com comentário": `recusado: <comentário>`. */
export function devApprovalRejectText(feedback: string): string {
	const text = feedback.trim().replace(/\s+/g, " ").slice(0, 1_000);
	return text ? `recusado: ${text}` : "recusado";
}

/** Comentário da recusa (`""` = sem comentário); `null` se o texto não é o token. */
export function parseDevApprovalReject(text: string): { feedback: string } | null {
	const match = /^recusado\s*(?::\s*([\s\S]*))?$/i.exec(text.trim());
	return match ? { feedback: (match[1] ?? "").trim() } : null;
}

/** Prévia de diff de escrita: remove/adiciona linhas, limitada. */
export function buildWritePreview(input: { oldText?: string; newText: string; maxLines?: number }): { preview: string; added: number; removed: number } {
	const max = input.maxLines ?? 40;
	const oldLines = input.oldText ? input.oldText.split("\n") : [];
	const newLines = input.newText ? input.newText.split("\n") : [];
	const lines = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)];
	const shown = lines.slice(0, max).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
	if (lines.length > max) shown.push(`… (+${lines.length - max} linhas)`);
	return { preview: shown.join("\n").slice(0, DEV_APPROVAL_PREVIEW_MAX_CHARS), added: newLines.length, removed: oldLines.length };
}

// ---------------------------------------------------------------------------
// Suíte inteira do monorepo: conselho (não aprovação)
// ---------------------------------------------------------------------------

export type FullSuiteMatch = {
	/** Trecho reconhecido, para mostrar ao agente. */
	command: string;
	/** `pnpm test` na raiz: só é a suíte inteira quando a pasta é a raiz de um workspace. */
	rootScript: boolean;
};

/** Flags que restringem a execução a alguns pacotes/projetos (então não é a suíte inteira). */
const SCOPING_FLAGS = new Set([
	"--filter", "-F", "--filter-prod", "--dir", "-C", "--prefix",
	"--workspace", "-w", "--projects", "-p", "--project", "--scope", "--since", "--affected", "--exclude", "--include", "--from", "--to",
]);
/** Dessas, as que levam o valor no argumento seguinte. */
const SCOPING_FLAGS_WITH_VALUE = new Set(["--filter", "-F", "--filter-prod", "--dir", "-C", "--prefix", "--workspace", "-w", "--projects", "-p", "--project", "--scope", "--since", "--exclude", "--include", "--from", "--to"]);

function isEnvAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	if (eq <= 0) return false;
	const name = word.slice(0, eq);
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i);
		const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
		if (!(letter || (i > 0 && c >= 48 && c <= 57))) return false;
	}
	return true;
}

function flagName(arg: string): string {
	const eq = arg.indexOf("=");
	return arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
}

function isTestScript(name: string | undefined, allowSuffix: boolean): boolean {
	if (!name) return false;
	return name === "test" || (allowSuffix && name.startsWith("test:"));
}

type ArgScan = { flags: string[]; positionals: string[]; scoped: boolean };

function scanArgs(args: readonly string[]): ArgScan {
	const flags: string[] = [];
	const positionals: string[] = [];
	let scoped = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") break;
		if (arg.startsWith("-") && arg.length > 1) {
			const name = flagName(arg);
			flags.push(name);
			if (SCOPING_FLAGS.has(name)) {
				scoped = true;
				if (SCOPING_FLAGS_WITH_VALUE.has(name) && !arg.includes("=")) i++;
			}
			continue;
		}
		positionals.push(arg);
	}
	return { flags, positionals, scoped };
}

function pnpmSuite(args: readonly string[]): FullSuiteMatch | null {
	const scan = scanArgs(args);
	if (scan.scoped) return null;
	const recursive = scan.flags.includes("-r") || scan.flags.includes("--recursive");
	let sub = scan.positionals[0];
	const script = scan.positionals[1];
	if (sub === "t" || sub === "tst") sub = "test";
	const viaRun = sub === "run" || sub === "run-script" || sub === "rum";
	const name = sub === "test" || (recursive && sub !== undefined && sub.startsWith("test:")) ? sub : viaRun ? script : undefined;
	if (!isTestScript(name, recursive)) return null;
	const shown = `pnpm ${recursive ? "-r " : ""}${viaRun ? `run ${name}` : name}`;
	if (recursive) return { command: shown, rootScript: false };
	return name === "test" ? { command: shown, rootScript: true } : null;
}

function turboSuite(args: readonly string[]): FullSuiteMatch | null {
	const scan = scanArgs(args);
	if (scan.scoped) return null;
	const tasks = scan.positionals[0] === "run" ? scan.positionals.slice(1) : scan.positionals;
	if (!tasks.some((task) => isTestScript(task, true))) return null;
	return { command: `turbo ${scan.positionals[0] === "run" ? "run " : ""}${tasks.join(" ")}`, rootScript: false };
}

function npmSuite(args: readonly string[]): FullSuiteMatch | null {
	const scan = scanArgs(args);
	if (scan.scoped) return null;
	if (!scan.flags.includes("--workspaces") && !scan.flags.includes("-ws")) return null;
	const sub = scan.positionals[0];
	const script = scan.positionals[1];
	const name = sub === "test" || sub === "t" || sub === "tst" ? "test" : sub === "run" || sub === "run-script" ? script : undefined;
	return isTestScript(name, true) ? { command: "npm run test --workspaces", rootScript: false } : null;
}

function yarnSuite(args: readonly string[]): FullSuiteMatch | null {
	const scan = scanArgs(args);
	if (scan.scoped || scan.positionals[0] !== "workspaces") return null;
	const rest = scan.positionals.slice(1);
	const sub = rest[0];
	if (sub === "run") return isTestScript(rest[1], true) ? { command: "yarn workspaces run test", rootScript: false } : null;
	if (sub === "foreach") {
		const at = rest.indexOf("run");
		return at >= 0 && isTestScript(rest[at + 1], true) ? { command: "yarn workspaces foreach run test", rootScript: false } : null;
	}
	return null;
}

function nxSuite(args: readonly string[]): FullSuiteMatch | null {
	const scan = scanArgs(args);
	if (scan.scoped || scan.positionals[0] !== "run-many") return null;
	const tail = args.slice(args.indexOf("run-many") + 1);
	for (let i = 0; i < tail.length; i++) {
		const arg = tail[i]!;
		const name = flagName(arg);
		if (name === "-t" || name === "--target" || name === "--targets") {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : tail[i + 1];
			if (value && value.split(",").some((target) => isTestScript(target, true))) return { command: "nx run-many -t test", rootScript: false };
		}
	}
	return null;
}

/**
 * Reconhece comandos que rodam a suíte de testes do monorepo inteiro (`pnpm -r test`,
 * `turbo test`, `npm test --workspaces`, `yarn workspaces run test`, `nx run-many -t test`,
 * `pnpm test` na raiz de um workspace) sem filtro de pacote. Puro; `null` = não é.
 */
export function detectFullSuiteTest(cmd: string): FullSuiteMatch | null {
	const parsed = parseCommand(cmd);
	if (!parsed.ok) return null;
	for (const segment of parsed.segments) {
		const words = [...segment.words];
		while (words.length > 0 && isEnvAssignment(words[0]!)) words.shift();
		if (words[0] === "corepack" || words[0] === "npx" || words[0] === "bunx") words.shift();
		if (words[0] === "pnpm" && (words[1] === "exec" || words[1] === "dlx") && words[2] === "turbo") words.splice(0, 3, "turbo");
		else if ((words[0] === "pnpm" || words[0] === "yarn") && words[1] === "turbo") words.shift();
		const [head, ...args] = words;
		const found = head === "pnpm" ? pnpmSuite(args) : head === "turbo" ? turboSuite(args) : head === "npm" ? npmSuite(args) : head === "yarn" ? yarnSuite(args) : head === "nx" ? nxSuite(args) : null;
		if (found) return found;
	}
	return null;
}

/** Confere também se `pnpm test` na raiz conta (só quando a pasta é a raiz de um workspace). */
export function isFullSuiteTestCommand(cmd: string, options: { rootIsWorkspace?: boolean } = {}): FullSuiteMatch | null {
	const found = detectFullSuiteTest(cmd);
	if (!found) return null;
	return found.rootScript && !options.rootIsWorkspace ? null : found;
}

const FULL_SUITE_PHRASES = [
	"todos os testes", "todos testes", "todo o teste", "toda a suite", "suite inteira", "suite completa",
	"suite toda", "testes todos", "todos os pacotes", "tudo", "full suite", "full test", "all tests", "whole suite", "entire suite", "run everything", "full",
];

function stripAccents(text: string): string {
	return text.normalize("NFD").split("").filter((ch) => ch.charCodeAt(0) < 0x300 || ch.charCodeAt(0) > 0x36f).join("");
}

function isWordChar(ch: string): boolean {
	return ch !== "" && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-");
}

/** O usuário pediu a suíte completa em alguma das falas recentes? */
export function userAskedForFullSuite(messages: readonly string[]): boolean {
	for (const message of messages) {
		const text = stripAccents(message.toLowerCase());
		for (const phrase of FULL_SUITE_PHRASES) {
			let from = 0;
			for (;;) {
				const at = text.indexOf(phrase, from);
				if (at < 0) break;
				const before = at === 0 ? "" : text[at - 1]!;
				const after = text[at + phrase.length] ?? "";
				if (!isWordChar(before) && !isWordChar(after)) return true;
				from = at + 1;
			}
		}
	}
	return false;
}

/** Mensagem de ferramenta (conselho, não aprovação) quando o agente tenta a suíte inteira sem o usuário ter pedido. */
export function fullSuiteAdvice(match: FullSuiteMatch, testCommand?: string | null): string {
	const fast = testCommand?.trim();
	const how = fast
		? `Este ambiente tem um comando de teste rápido: rode \`${fast}\`.`
		: "Rode só os pacotes que você mudou: veja `git diff --name-only`, descubra o pacote de cada arquivo (o package.json mais próximo) e rode `pnpm --filter <pacote> test` (ou o equivalente do projeto), um pacote por vez.";
	return `Não rodei \`${match.command}\`: a suíte do monorepo inteiro leva vários minutos neste sandbox pequeno e alguns pacotes precisam de serviços que ele não tem (banco Postgres, navegador Chrome). ${how} Rode a suíte inteira só se o usuário pedir ("todos os testes", "suíte completa").`;
}
