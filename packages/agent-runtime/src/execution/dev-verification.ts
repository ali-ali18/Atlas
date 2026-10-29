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

/** O comando é de verificação (teste, typecheck, lint, build)? `testCommand` é o comando de teste do ambiente, se conhecido. */
export function isVerificationCommand(cmd: string, testCommand?: string | null): boolean {
	const known = testCommand ? collapse(testCommand) : "";
	if (known && collapse(cmd).includes(known)) return true;
	const parsed = parseCommand(cmd);
	if (!parsed.ok) return false;
	return parsed.segments.some((segment) => segmentIsCheck(segment.words));
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
