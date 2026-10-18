import type { DevClient } from "@workspace/sandbox";

/**
 * Diagnósticos depois de editar arquivos TS/JS: um typecheck do pacote afetado roda em segundo plano
 * (nunca bloqueia a edição) e o resultado entra no próximo resultado de tool como um bloco curto.
 */

const NL = String.fromCharCode(10);
const WORKSPACE = "/workspace";

export const DIAGNOSTICS_DEBOUNCE_MS = 20_000;
/** Junta uma rajada de edições antes da primeira execução. */
export const DIAGNOSTICS_SETTLE_MS = 1_500;
export const DIAGNOSTICS_MAX_PER_FILE = 10;
export const DIAGNOSTICS_MAX_TOTAL = 30;
const MESSAGE_MAX_CHARS = 300;
const TYPECHECK_TIMEOUT_MS = 180_000;
const DETECT_TIMEOUT_MS = 15_000;
const OUTPUT_MAX_CHARS = 2_000_000;

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export type Diagnostic = { file: string; line: number; col: number; severity: "error" | "warning"; code: string; message: string };
export type TypecheckTarget = { pkgDir: string; cmd: string };

/** `DEV_AFTER_EDIT_DIAGNOSTICS=off` (ou 0/false) desliga; ligado por padrão (só age quando há comando de typecheck). */
export function diagnosticsEnabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
	const value = (env.DEV_AFTER_EDIT_DIAGNOSTICS ?? "").trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false" || value === "no");
}

export function isDiagnosableFile(path: string): boolean {
	const lower = path.toLowerCase();
	if (lower.endsWith(".d.ts")) return false;
	return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function joinPath(base: string, file: string): string {
	if (file.startsWith("/")) return normalizePath(file);
	return normalizePath(`${base}/${file}`);
}

function normalizePath(path: string): string {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** `src/a.ts(12,5): error TS2322: mensagem` (formato do tsc sem --pretty); aceita prefixo de turbo/pnpm antes do caminho. */
export function parseTsDiagnostics(output: string, baseDir: string): Diagnostic[] {
	const found: Diagnostic[] = [];
	const seen = new Set<string>();
	for (const raw of output.split(NL)) {
		const line = raw.endsWith(String.fromCharCode(13)) ? raw.slice(0, -1) : raw;
		let severity: "error" | "warning" = "error";
		let at = line.indexOf("): error TS");
		if (at < 0) {
			at = line.indexOf("): warning TS");
			severity = "warning";
		}
		if (at < 0) continue;
		const open = line.lastIndexOf("(", at);
		if (open < 0) continue;
		const where = line.slice(open + 1, at).split(",");
		const lineNo = Number(where[0]);
		const colNo = Number(where[1]);
		if (!Number.isInteger(lineNo) || !Number.isInteger(colNo)) continue;
		let file = line.slice(0, open);
		const space = file.lastIndexOf(" ");
		if (space >= 0) file = file.slice(space + 1);
		if (!file || !CODE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) continue;
		const body = line.slice(at + 3);
		const rest = body.slice(body.indexOf(" ") + 1);
		const colon = rest.indexOf(":");
		if (colon < 0) continue;
		const code = rest.slice(0, colon).trim();
		const message = rest.slice(colon + 1).trim().slice(0, MESSAGE_MAX_CHARS);
		const diagnostic: Diagnostic = { file: joinPath(baseDir, file), line: lineNo, col: colNo, severity, code, message };
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		found.push(diagnostic);
	}
	return found;
}

export function diagnosticKey(d: Diagnostic): string {
	return `${d.file}:${d.line}:${d.col}:${d.code}:${d.message}`;
}

/** Chave de "já mostrei": sem linha/coluna, para não repetir o mesmo erro quando uma edição só desloca as linhas. */
export function reportedKey(d: Diagnostic): string {
	return `${d.file}:${d.code}:${d.message}`;
}

const displayPath = (file: string) => (file.startsWith(`${WORKSPACE}/`) ? file.slice(WORKSPACE.length + 1) : file);

/**
 * Escolhe o que mostrar: erros antes de avisos, arquivos editados primeiro, no máximo 10 por arquivo e 30 no total,
 * sem repetir o que já foi mostrado neste run (`reported`, atualizado aqui). Sem nada novo devolve null.
 */
export function formatDiagnosticsBlock(all: readonly Diagnostic[], reported: Set<string>, edited: ReadonlySet<string> = new Set()): string | null {
	const fresh = all.filter((d) => !reported.has(reportedKey(d)));
	if (fresh.length === 0) return null;
	const rank = (d: Diagnostic) => (d.severity === "error" ? 0 : 1);
	const sorted = [...fresh].sort((a, b) => rank(a) - rank(b) || Number(edited.has(b.file)) - Number(edited.has(a.file)) || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
	const perFile = new Map<string, number>();
	const shown: Diagnostic[] = [];
	for (const d of sorted) {
		if (shown.length >= DIAGNOSTICS_MAX_TOTAL) break;
		const count = perFile.get(d.file) ?? 0;
		if (count >= DIAGNOSTICS_MAX_PER_FILE) continue;
		perFile.set(d.file, count + 1);
		shown.push(d);
	}
	for (const d of shown) reported.add(reportedKey(d));
	const omitted = fresh.length - shown.length;
	const lines = shown.map((d) => `- ${displayPath(d.file)}:${d.line}:${d.col} ${d.severity} ${d.code}: ${d.message}`);
	return [`Diagnósticos após a edição (typecheck, ${shown.length} ${shown.length === 1 ? "item" : "itens"}):`, ...lines, ...(omitted > 0 ? [`(+${omitted} omitidos)`] : [])].join(NL);
}

// ---------------------------------------------------------------------------
// Agendador: no máximo uma execução por pacote a cada 20s, edições juntas
// ---------------------------------------------------------------------------

export type DiagnosticsSchedulerOptions = {
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	debounceMs?: number;
	settleMs?: number;
	/** Roda o typecheck e devolve os diagnósticos (null/erro = nada a mostrar). */
	run: (target: TypecheckTarget) => Promise<Diagnostic[] | null>;
	onResult: (target: TypecheckTarget, diagnostics: Diagnostic[]) => void;
};

export function createDiagnosticsScheduler(options: DiagnosticsSchedulerOptions) {
	const debounceMs = options.debounceMs ?? DIAGNOSTICS_DEBOUNCE_MS;
	const settleMs = options.settleMs ?? DIAGNOSTICS_SETTLE_MS;
	type State = { target: TypecheckTarget; lastStart?: number; running: boolean; dirty: boolean; timer?: unknown };
	const states = new Map<string, State>();
	// Um typecheck por vez no container (a sandbox pequena não aguenta dois tsc).
	let queue: Promise<void> = Promise.resolve();

	function start(state: State) {
		state.running = true;
		state.dirty = false;
		state.lastStart = options.now();
		queue = queue
			.then(async () => {
				const diagnostics = await options.run(state.target);
				if (diagnostics) options.onResult(state.target, diagnostics);
			})
			.catch(() => undefined)
			.finally(() => {
				state.running = false;
				if (state.dirty) schedule(state.target);
			});
	}

	function schedule(target: TypecheckTarget) {
		let state = states.get(target.pkgDir);
		if (!state) {
			state = { target, running: false, dirty: false };
			states.set(target.pkgDir, state);
		}
		state.target = target;
		if (state.running) {
			state.dirty = true;
			return;
		}
		if (state.timer !== undefined) return; // já agendado: a edição entra na mesma execução
		const sinceLast = state.lastStart === undefined ? Number.POSITIVE_INFINITY : options.now() - state.lastStart;
		const wait = Math.max(settleMs, debounceMs - sinceLast);
		const current = state;
		current.timer = options.setTimer(() => {
			current.timer = undefined;
			start(current);
		}, wait);
	}

	return {
		schedule,
		/** Cancela timers pendentes (fim do run). */
		dispose() {
			for (const state of states.values()) {
				if (state.timer !== undefined) options.clearTimer?.(state.timer);
				state.timer = undefined;
			}
		},
		/** Só para testes: espera as execuções enfileiradas. */
		async idle() {
			await queue;
		},
	};
}

// ---------------------------------------------------------------------------
// Integração com o container
// ---------------------------------------------------------------------------

/** Acha o package.json mais próximo e o comando de typecheck (script `typecheck` ou `tsc --noEmit -p <tsconfig mais próximo>`). */
export const DETECT_SCRIPT = [
	'f="$DEV_DIAG_FILE"',
	'd=$(dirname "$f")',
	'ts=""',
	"while true; do",
	'  if [ -z "$ts" ] && [ -f "$d/tsconfig.json" ]; then ts="$d/tsconfig.json"; fi',
	'  if [ -f "$d/package.json" ]; then break; fi',
	'  if [ "$d" = "/workspace" ] || [ "$d" = "/" ] || [ "$d" = "." ]; then break; fi',
	'  d=$(dirname "$d")',
	"done",
	'[ -f "$d/package.json" ] || exit 0',
	"pm=npm",
	'if [ -f /workspace/pnpm-lock.yaml ]; then pm=pnpm; elif [ -f /workspace/yarn.lock ]; then pm=yarn; elif [ -f /workspace/bun.lockb ]; then pm=bun; fi',
	'echo "PKG=$d"',
	'if grep -q \'"typecheck"[[:space:]]*:\' "$d/package.json"; then echo "CMD=$pm run typecheck"; exit 0; fi',
	'tsc=""',
	'for b in "$d/node_modules/.bin/tsc" /workspace/node_modules/.bin/tsc; do if [ -x "$b" ]; then tsc="$b"; break; fi; done',
	'if [ -n "$tsc" ] && [ -n "$ts" ]; then echo "CMD=$tsc --noEmit --pretty false -p \'$ts\'"; fi',
].join(NL);

export function parseDetectOutput(output: string): TypecheckTarget | null {
	let pkgDir = "";
	let cmd = "";
	for (const line of output.split(NL)) {
		if (line.startsWith("PKG=")) pkgDir = line.slice(4).trim();
		else if (line.startsWith("CMD=")) cmd = line.slice(4).trim();
	}
	return pkgDir && cmd ? { pkgDir: normalizePath(pkgDir), cmd } : null;
}

export type AfterEditDiagnosticsDeps = {
	withClient: <T>(fn: (client: DevClient) => Promise<T>) => Promise<T>;
	getEnv: () => Promise<Record<string, string>>;
	redact?: (text: string) => string;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	debounceMs?: number;
	settleMs?: number;
};

export function createAfterEditDiagnostics(deps: AfterEditDiagnosticsDeps) {
	const now = deps.now ?? Date.now;
	const setTimer =
		deps.setTimer ??
		((fn: () => void, ms: number) => {
			const handle = setTimeout(fn, ms);
			(handle as { unref?: () => void }).unref?.();
			return handle;
		});
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const detected = new Map<string, TypecheckTarget | null>();
	const edited = new Set<string>();
	const reported = new Set<string>();
	const pending = new Map<string, Diagnostic[]>();

	/** Roda um comando no container até o fim e devolve a saída (stdout+stderr). */
	async function runToEnd(cmd: string, env: Record<string, string>, cwd: string | undefined, timeoutMs: number): Promise<{ output: string; exitCode: number | null }> {
		return deps.withClient(async (client) => {
			const { id } = await client.execStart({ cmd, ...(cwd ? { cwd } : {}), env, timeoutMs });
			let output = "";
			let out = 0;
			let err = 0;
			const deadline = now() + timeoutMs + 5_000;
			for (;;) {
				const snap = await client.execPoll(id, { out, err, waitMs: 10_000 });
				out = snap.nextOut;
				err = snap.nextErr;
				if (output.length < OUTPUT_MAX_CHARS) output += `${snap.stdout}${NL}${snap.stderr}${NL}`;
				if (!snap.running) return { output, exitCode: snap.exitCode };
				if (now() > deadline) return { output, exitCode: null };
			}
		});
	}

	async function detect(path: string): Promise<TypecheckTarget | null> {
		const dir = path.slice(0, Math.max(0, path.lastIndexOf("/"))) || WORKSPACE;
		if (detected.has(dir)) return detected.get(dir) ?? null;
		const env = { ...(await deps.getEnv()), DEV_DIAG_FILE: path };
		const { output } = await runToEnd(DETECT_SCRIPT, env, WORKSPACE, DETECT_TIMEOUT_MS);
		const target = parseDetectOutput(output);
		detected.set(dir, target);
		return target;
	}

	const scheduler = createDiagnosticsScheduler({
		now,
		setTimer,
		clearTimer,
		debounceMs: deps.debounceMs,
		settleMs: deps.settleMs,
		run: async (target) => {
			const env = await deps.getEnv();
			const { output } = await runToEnd(target.cmd, env, target.pkgDir, TYPECHECK_TIMEOUT_MS);
			return parseTsDiagnostics(deps.redact ? deps.redact(output) : output, target.pkgDir);
		},
		onResult: (target, diagnostics) => {
			pending.set(target.pkgDir, diagnostics);
		},
	});

	return {
		/** Avisa que `path` (absoluto no container) foi escrito. Nunca bloqueia nem lança. */
		noteEdit(path: string): void {
			if (!isDiagnosableFile(path)) return;
			edited.add(path);
			void detect(path)
				.then((target) => {
					if (target) scheduler.schedule(target);
				})
				.catch(() => undefined);
		},
		/** Bloco pronto para anexar ao próximo resultado de tool; null quando não há nada novo. */
		take(): string | null {
			if (pending.size === 0) return null;
			const all = [...pending.values()].flat();
			pending.clear();
			return formatDiagnosticsBlock(all, reported, edited);
		},
		scheduler,
		dispose: () => scheduler.dispose(),
	};
}
