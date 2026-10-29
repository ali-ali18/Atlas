import { parseCommand } from "@workspace/shared";

/**
 * Verificação no run de código: o run sabe se editou arquivos na sessão de código depois do último comando de
 * verificação (teste, typecheck, lint, build) que passou. Decisão pura sobre o que as tools devolveram: sem I/O.
 *
 * Usado por dois portões: (1) o limite brando não encerra o run enquanto há edição sem verificar (ou verificação
 * rodando em segundo plano); (2) a resposta final com edição sem verificar volta ao modelo uma vez.
 */

/** Cutucada ao modelo (texto de modelo: inglês) quando ele quer terminar com edição sem verificar. */
export const VERIFY_BEFORE_DONE_NOTE =
	"You edited files in the code session but have not run a test, typecheck, lint or build that passed since your last edit. " +
	"Before finishing, run the project's check that is relevant to what you changed (the environment's test command if you know it) and report its real result. " +
	"If you cannot run one, say plainly why in your final answer.";

/** Teto de extensões do limite brando só por edição sem verificar (o teto duro e o relógio seguem valendo). */
export const MAX_VERIFY_EXTENSIONS = 2;

const SCRIPT_NAME = /^(test|tests|typecheck|type-check|tsc|check|lint|build|verify|ci|validate)(:[\w:.-]+)?$/;
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
/** Flags de gerenciador de pacote que levam o valor na palavra seguinte. */
const FLAGS_WITH_VALUE = new Set(["--filter", "-F", "--filter-prod", "--dir", "-C", "--prefix", "--workspace", "-w", "--cwd"]);
/** Ferramentas que, rodadas direto, já são teste/checagem. */
const DIRECT_CHECKERS = new Set(["vitest", "jest", "mocha", "ava", "tsc", "vue-tsc", "eslint", "oxlint", "pytest", "py.test", "mypy", "ruff", "flake8", "pyright", "rspec", "phpunit", "phpstan", "tox", "nox"]);
const SUBCOMMAND_CHECKERS: Record<string, ReadonlySet<string>> = {
	cargo: new Set(["test", "check", "clippy", "build", "nextest"]),
	go: new Set(["test", "vet", "build"]),
	dotnet: new Set(["test", "build"]),
	deno: new Set(["test", "check", "lint"]),
	bun: new Set(["test"]),
	biome: new Set(["check", "lint", "ci"]),
	make: new Set(["test", "check", "build", "lint", "all"]),
	mvn: new Set(["test", "verify", "package", "compile"]),
	gradle: new Set(["test", "check", "build"]),
	next: new Set(["build"]),
	vite: new Set(["build"]),
	turbo: new Set(["test", "typecheck", "lint", "build", "check"]),
	nx: new Set(["test", "lint", "build", "typecheck"]),
};

const isEnvAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function segmentIsCheck(rawWords: readonly string[]): boolean {
	const words = [...rawWords];
	while (words.length > 0 && isEnvAssignment(words[0]!)) words.shift();
	while (words[0] === "npx" || words[0] === "bunx" || words[0] === "corepack" || words[0] === "time") words.shift();
	if ((words[0] === "pnpm" || words[0] === "yarn" || words[0] === "npm") && (words[1] === "exec" || words[1] === "dlx")) words.splice(0, 2);
	const head = words[0]?.replace(/^\.\//, "");
	if (!head) return false;
	if (DIRECT_CHECKERS.has(head)) return true;
	const args = words.slice(1);
	if ((head === "tsx" || head === "node") && args.includes("--test")) return true;
	if (head === "./gradlew" || head === "gradlew") return args.some((arg) => SUBCOMMAND_CHECKERS.gradle!.has(arg));
	if (head === "mvnw") return args.some((arg) => SUBCOMMAND_CHECKERS.mvn!.has(arg));
	if (PACKAGE_MANAGERS.has(head)) {
		const rest: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!;
			if (arg === "--") break;
			if (arg.startsWith("-")) {
				if (FLAGS_WITH_VALUE.has(arg)) i++;
				continue;
			}
			rest.push(arg);
		}
		const sub = rest[0];
		const script = sub === "run" || sub === "run-script" || sub === "rum" ? rest[1] : sub;
		if (script && SCRIPT_NAME.test(script)) return true;
		if (head === "bun" && sub === "test") return true;
		if ((head === "pnpm" || head === "yarn") && sub === "turbo") return args.some((arg) => SUBCOMMAND_CHECKERS.turbo!.has(arg));
		return false;
	}
	const subcommands = SUBCOMMAND_CHECKERS[head];
	return subcommands ? args.some((arg) => subcommands.has(arg)) : false;
}

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

type Piece = { text: string; sepBefore: string; sepAfter: string };

/**
 * Quebra o comando nos operadores de lista/pipe fora de aspas. `null` = não deu para ter certeza
 * (subshell, substituição, aspas abertas): quem chama trata como não verificado.
 */
function splitTopLevel(cmd: string): Piece[] | null {
	const pieces: Piece[] = [];
	let buf = "";
	let sepBefore = "";
	let quote: string | null = null;
	const push = (sepAfter: string) => {
		pieces.push({ text: buf.trim(), sepBefore, sepAfter });
		buf = "";
		sepBefore = sepAfter;
	};
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				buf += ch + (cmd[i + 1] ?? "");
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			else if (quote === '"' && (ch === "`" || (ch === "$" && cmd[i + 1] === "("))) return null;
			buf += ch;
			continue;
		}
		if (ch === "\\") {
			buf += ch + (cmd[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "`" || ch === "(" || ch === ")") return null;
		if (ch === "&" && cmd[i + 1] === "&") {
			push("&&");
			i++;
		} else if (ch === "|" && cmd[i + 1] === "|") {
			push("||");
			i++;
		} else if (ch === "|") {
			if (cmd[i + 1] === "&") i++;
			push("|");
		} else if (ch === "&") {
			// `2>&1`, `>&2` e `&>arquivo` são redirecionamento, não segundo plano.
			if (cmd[i - 1] === ">" || cmd[i + 1] === ">") buf += ch;
			else push("&");
		} else if (ch === ";" || ch === "\n") push(";");
		else buf += ch;
	}
	if (quote) return null;
	pieces.push({ text: buf.trim(), sepBefore, sepAfter: "" });
	return pieces.filter((piece) => piece.text !== "" || piece.sepAfter !== "");
}

/**
 * O comando é de verificação (teste, typecheck, lint, build) e o status dele chega ao exit code do comando todo?
 * `pnpm test | tail`, `pnpm test || true` e `pnpm test; echo ok` saem com 0 mesmo com teste falhando, então não contam.
 * `testCommand` é o comando de teste do ambiente, se conhecido.
 */
export function isVerificationCommand(cmd: string, testCommand?: string | null): boolean {
	const known = testCommand ? collapse(testCommand) : "";
	const pieces = splitTopLevel(cmd);
	if (!pieces) return false;
	const pipefail = pieces.some((piece) => /(^|\s)(pipefail|-[A-Za-z]*o\s+pipefail)(\s|$)/.test(piece.text) && /^set\s/.test(piece.text));
	const isCheck = (text: string) => {
		if (known && collapse(text).includes(known)) return true;
		const parsed = parseCommand(text);
		return parsed.ok && parsed.segments.some((segment) => segmentIsCheck(segment.words));
	};
	if (known && known.search(/&&|\|\||[;|]/) !== -1 && collapse(cmd).endsWith(known)) return true;
	return pieces.some((piece, index) => {
		if (piece.text === "" || !isCheck(piece.text)) return false;
		// Antes: `||` e `&` podem fazer o comando nem rodar (ou rodar solto).
		if (pieces.slice(0, index + 1).some((p) => p.sepBefore === "||" || p.sepBefore === "&")) return false;
		// Depois: só `&&` preserva o status; `|` só com pipefail; o resto mascara.
		return pieces.slice(index).every((p) => p.sepAfter === "" || p.sepAfter === "&&" || (p.sepAfter === "|" && pipefail));
	});
}

/**
 * Arquivo que pede verificação: código e configuração que pode quebrar build/teste (json, yaml, toml…).
 * Fora: documentação e texto, imagens e fontes, lockfiles, `.env*` e arquivos de metadado sem código.
 * Editar só um README não deve estender o run nem cobrar teste.
 */
const NON_CODE_EXT = new Set([
	"md", "mdx", "markdown", "txt", "rst", "adoc", "org", "rtf", "log", "csv", "tsv",
	"png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg", "pdf", "mp3", "mp4", "mov", "woff", "woff2", "ttf", "otf", "eot", "lock", "lockb",
]);
const NON_CODE_NAME = /^(?:\.env(?:\..*)?|license(?:\..*)?|licence|notice|authors|contributors|changelog(?:\..*)?|readme(?:\..*)?|codeowners|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.editorconfig|\.prettierignore|\.eslintignore|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock|gemfile\.lock|go\.sum)$/i;

export function isCodeFile(path: string): boolean {
	const name = path.split(/[\\/]/).pop() ?? path;
	if (NON_CODE_NAME.test(name)) return false;
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? true : !NON_CODE_EXT.has(name.slice(dot + 1).toLowerCase());
}

type VerificationJob = { verification: boolean; startSeq: number };

export type DevVerificationInput = {
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
	summary: string;
};

/**
 * Estado por run. `note` recebe cada resultado de tool; as perguntas são síncronas.
 * `getTestCommand` só é chamado para um comando que a classificação por palavras não reconheceu.
 */
export function createDevVerificationTracker(options: { getTestCommand?: () => Promise<string | null | undefined> } = {}) {
	let seq = 0;
	/** Arquivo editado e a sequência da edição. Sai quando uma verificação que começou depois dele passa. */
	const unverified = new Map<string, number>();
	const jobs = new Map<string, VerificationJob>();
	let testCommandLoaded = false;
	let testCommand: string | null | undefined;

	const loadTestCommand = async () => {
		if (testCommandLoaded) return testCommand;
		testCommandLoaded = true;
		try {
			testCommand = await options.getTestCommand?.();
		} catch {
			testCommand = undefined;
		}
		return testCommand;
	};

	const verified = (upToSeq: number) => {
		for (const [path, at] of unverified) if (at <= upToSeq) unverified.delete(path);
	};

	const classify = async (cmd: string) => {
		if (isVerificationCommand(cmd)) return true;
		const known = options.getTestCommand ? await loadTestCommand() : undefined;
		return known ? isVerificationCommand(cmd, known) : false;
	};

	return {
		async note(input: DevVerificationInput): Promise<void> {
			const { name, args, ok, summary } = input;
			if (!ok) return;
			if ((name === "edit_file" || name === "write_file") && typeof args.path === "string") {
				// Escrita que parou no cartão de aprovação não mexeu em nada.
				if (/^Aprovação pendente/.test(summary)) return;
				// Doc, imagem, lockfile e .env não pedem teste: não contam como edição sem verificar.
				if (!isCodeFile(args.path)) return;
				seq += 1;
				unverified.set(args.path, seq);
				return;
			}
			if (name === "shell" && typeof args.cmd === "string") {
				const verification = await classify(args.cmd);
				const startSeq = seq;
				const jobId = /job_id=([0-9a-f]+)/.exec(summary)?.[1];
				if (/^exit 0\b/.test(summary)) {
					if (verification) verified(startSeq);
				} else if (jobId && /still_running: true|segundo plano|já está rodando/.test(summary)) {
					jobs.set(jobId, { verification, startSeq });
				}
				return;
			}
			if (name === "shell_output" && typeof args.jobId === "string") {
				const job = jobs.get(args.jobId);
				if (!job) return;
				if (/^job \S+: rodando/.test(summary)) return;
				jobs.delete(args.jobId);
				if (job.verification && /\(exit 0\)/.test(summary.split("\n", 1)[0] ?? "")) verified(job.startSeq);
				return;
			}
			if (name === "shell_kill" && typeof args.jobId === "string") jobs.delete(args.jobId);
		},
		/** Editou arquivo na sessão de código depois da última verificação que passou. */
		hasUnverifiedEdits: () => unverified.size > 0,
		/** Há comando de verificação ainda rodando em segundo plano (servidor de desenvolvimento não conta). */
		hasRunningVerification: () => [...jobs.values()].some((job) => job.verification),
		/** O trabalho de código ainda não fechou: edição sem verificar ou verificação em andamento. */
		needsMoreWork: () => unverified.size > 0 || [...jobs.values()].some((job) => job.verification),
	};
}

export type DevVerificationTracker = ReturnType<typeof createDevVerificationTracker>;
