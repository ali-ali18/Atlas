import Docker from "dockerode";
import { createDockerClient } from "../docker-manager.js";
import { CODE_RUNNER_LABEL, CODE_RUNNER_UID, type CodeRunnerConfig } from "./config.js";
import { packTar, unpackTar, type TarFile } from "./tar.js";

export const CODE_RUNNER_MARKER = "__ATLAS_CODE_RUN_DONE__";
const CODE_MAX_CHARS = 200_000;
/** Folga além do timeout do código para subir o container, copiar arquivos e ler a saída. */
const HOST_GRACE_MS = 20_000;
const FILE_NAME_MAX = 90;

/** Mensagem pensada para o modelo repassar ao usuário em português. */
export class CodeRunnerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodeRunnerUnavailableError";
	}
}

/** Entrada inválida (código vazio, arquivos demais...): erro acionável para o modelo. */
export class CodeRunnerInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodeRunnerInputError";
	}
}

export type CodeRunnerInputFile = { name: string; bytes: Uint8Array };
export type CodeRunnerOutputFile = { name: string; bytes: Uint8Array };

export type CodeRunInput = {
	code: string;
	files?: CodeRunnerInputFile[];
	timeoutSec?: number;
	signal?: AbortSignal;
	/** Labels extras (ex.: runId) para identificar o container. */
	labels?: Record<string, string>;
};

export type CodeRunResult = {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	outputs: CodeRunnerOutputFile[];
	/** Arquivos de /work/out que não couberam nos limites (nome + motivo). */
	omitted: string[];
	/** Nomes finais dos arquivos de entrada em /work/in. */
	inputNames: string[];
	/** O container terminou sem entregar resultado (morto por memória, etc.). */
	crashed: boolean;
};

let running = 0;

/** Testes. */
export function resetCodeRunnerStateForTest(): void {
	running = 0;
}

export function sanitizeInputName(name: string, taken: Set<string>): string {
	let base = (name.split(/[\\/]/).pop() ?? "").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").trim();
	if (!base) base = "arquivo";
	if (base.length > FILE_NAME_MAX) {
		const dot = base.lastIndexOf(".");
		const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
		base = base.slice(0, FILE_NAME_MAX - ext.length) + ext;
	}
	let candidate = base;
	for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
		const dot = base.lastIndexOf(".");
		candidate = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
	}
	taken.add(candidate.toLowerCase());
	return candidate;
}

export function truncateStream(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	return {
		text: `${text.slice(0, head)}\n[... ${text.length - max} caracteres omitidos ...]\n${text.slice(text.length - tail)}`,
		truncated: true,
	};
}

async function collect(stream: NodeJS.ReadableStream | Buffer, maxBytes: number): Promise<Buffer> {
	if (Buffer.isBuffer(stream)) return stream;
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream as AsyncIterable<Buffer | string>) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buf.length;
		if (total > maxBytes) {
			(stream as { destroy?: () => void }).destroy?.();
			throw new Error("saída grande demais");
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

function isMissing(error: unknown): boolean {
	return (error as { statusCode?: number } | undefined)?.statusCode === 404;
}

function unavailable(error: unknown, image: string): CodeRunnerUnavailableError {
	if (isMissing(error)) {
		return new CodeRunnerUnavailableError(`O executor de código não está instalado neste servidor (imagem ${image} ausente). Avise o usuário e use outra abordagem.`);
	}
	return new CodeRunnerUnavailableError("O executor de código não está disponível agora (Docker inacessível). Avise o usuário e use outra abordagem.");
}

function validate(input: CodeRunInput, config: CodeRunnerConfig): { timeoutSec: number; files: CodeRunnerInputFile[] } {
	if (typeof input.code !== "string" || !input.code.trim()) throw new CodeRunnerInputError("code vazio: envie o código Python a executar.");
	if (input.code.length > CODE_MAX_CHARS) throw new CodeRunnerInputError(`code grande demais (máx. ${CODE_MAX_CHARS} caracteres).`);
	const requested = input.timeoutSec ?? config.defaultTimeoutSec;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) throw new CodeRunnerInputError("timeoutSec deve ser um número positivo.");
	const timeoutSec = Math.min(config.maxTimeoutSec, Math.floor(requested));
	const files = input.files ?? [];
	if (files.length > config.maxInputFiles) throw new CodeRunnerInputError(`arquivos demais (máx. ${config.maxInputFiles}).`);
	const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
	if (total > config.maxInputBytes) throw new CodeRunnerInputError(`arquivos de entrada somam mais de ${Math.round(config.maxInputBytes / 1024 / 1024)} MB.`);
	const taken = new Set<string>();
	return { timeoutSec, files: files.map((file) => ({ name: sanitizeInputName(file.name, taken), bytes: file.bytes })) };
}

/** Espera o marcador no log do container; resolve false se o log acabou sem ele (container morreu). */
async function waitForMarker(container: Docker.Container, signal: AbortSignal): Promise<boolean> {
	const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream | Buffer;
	if (Buffer.isBuffer(stream)) return stream.includes(CODE_RUNNER_MARKER);
	let tail = "";
	const onAbort = () => (stream as { destroy?: () => void }).destroy?.();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for await (const chunk of stream as AsyncIterable<Buffer | string>) {
			tail = (tail + chunk.toString("latin1")).slice(-(CODE_RUNNER_MARKER.length * 2));
			if (tail.includes(CODE_RUNNER_MARKER)) {
				(stream as { destroy?: () => void }).destroy?.();
				return true;
			}
		}
	} catch {
		return false;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	return false;
}

async function readOutputs(container: Docker.Container, config: CodeRunnerConfig): Promise<{ outputs: CodeRunnerOutputFile[]; omitted: string[] }> {
	const outputs: CodeRunnerOutputFile[] = [];
	const omitted: string[] = [];
	let archive: Buffer;
	try {
		archive = await collect((await container.getArchive({ path: "/work/out" })) as unknown as NodeJS.ReadableStream, config.maxOutputBytes * 2 + 1024 * 1024);
	} catch (error) {
		if (isMissing(error)) return { outputs, omitted };
		return { outputs, omitted: ["/work/out: saída grande demais ou ilegível"] };
	}
	let total = 0;
	const files = unpackTar(archive)
		.map((file) => ({ ...file, name: file.name.replace(/^\.?\/?out\//, "") }))
		.filter((file) => file.name && !file.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const file of files) {
		if (file.bytes.byteLength === 0) {
			omitted.push(`${file.name} (vazio)`);
		} else if (outputs.length >= config.maxOutputFiles) {
			omitted.push(`${file.name} (limite de ${config.maxOutputFiles} arquivos)`);
		} else if (total + file.bytes.byteLength > config.maxOutputBytes) {
			omitted.push(`${file.name} (limite de ${Math.round(config.maxOutputBytes / 1024 / 1024)} MB)`);
		} else {
			total += file.bytes.byteLength;
			outputs.push({ name: file.name, bytes: file.bytes });
		}
	}
	return { outputs, omitted };
}

type RunnerJson = { exit_code?: number | null; timed_out?: boolean; duration_ms?: number; stdout?: string; stderr?: string };

async function readResultJson(container: Docker.Container): Promise<RunnerJson | null> {
	try {
		const archive = await collect((await container.getArchive({ path: "/work/.result.json" })) as unknown as NodeJS.ReadableStream, 1024 * 1024);
		const file = unpackTar(archive)[0];
		return file ? (JSON.parse(new TextDecoder().decode(file.bytes)) as RunnerJson) : null;
	} catch {
		return null;
	}
}

export function buildContainerSpec(config: CodeRunnerConfig, timeoutSec: number, labels: Record<string, string> = {}): Docker.ContainerCreateOptions {
	return {
		Image: config.image,
		Cmd: ["python", "/app/run.py"],
		WorkingDir: "/work",
		User: `${CODE_RUNNER_UID}:${CODE_RUNNER_UID}`,
		Env: [`CODE_TIMEOUT_SEC=${timeoutSec}`, "MPLBACKEND=Agg", "MPLCONFIGDIR=/tmp/mpl", "HOME=/tmp"],
		Labels: { ...labels, [CODE_RUNNER_LABEL]: "1", "atlas.code-runner.created": String(Date.now()) },
		NetworkDisabled: true,
		AttachStdin: false,
		HostConfig: {
			NetworkMode: "none",
			Memory: config.memoryBytes,
			MemorySwap: config.memoryBytes,
			NanoCpus: config.nanoCpus,
			PidsLimit: config.pidsLimit,
			ReadonlyRootfs: true,
			// /work é um volume anônimo do driver local montado como tmpfs (limite de tamanho, some com o container
			// via AutoRemove). Precisa ser volume: putArchive não enxerga um tmpfs comum de container em execução.
			Mounts: [
				{
					Type: "volume",
					Source: "",
					Target: "/work",
					VolumeOptions: {
						NoCopy: true,
						Labels: { [CODE_RUNNER_LABEL]: "1" },
						DriverConfig: {
							Name: "local",
							Options: { type: "tmpfs", device: "tmpfs", o: `size=160m,uid=${CODE_RUNNER_UID},gid=${CODE_RUNNER_UID},mode=0755,nosuid` },
						},
					},
				},
				{ Type: "tmpfs", Source: "", Target: "/tmp", TmpfsOptions: { SizeBytes: 128 * 1024 * 1024, Mode: 0o1777 } },
			],
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			AutoRemove: true,
			Privileged: false,
		},
	};
}

export type CodeRunnerDeps = { docker?: Docker };

/** Executa o código em um container efêmero e devolve stdout/stderr e os arquivos de /work/out. */
export async function runCode(input: CodeRunInput, config: CodeRunnerConfig, deps: CodeRunnerDeps = {}): Promise<CodeRunResult> {
	if (!config.enabled) throw new CodeRunnerUnavailableError("O executor de código está desligado neste servidor. Avise o usuário e use outra abordagem.");
	const { timeoutSec, files } = validate(input, config);
	if (running >= config.maxConcurrent) throw new CodeRunnerUnavailableError("O executor de código está ocupado com outras execuções. Tente de novo em instantes.");
	const docker = deps.docker ?? createDockerClient(config);
	try {
		await docker.getImage(config.image).inspect();
	} catch (error) {
		throw unavailable(error, config.image);
	}

	running += 1;
	const started = Date.now();
	let container: Docker.Container | undefined;
	const hostAbort = new AbortController();
	const forwardAbort = () => hostAbort.abort();
	input.signal?.addEventListener("abort", forwardAbort, { once: true });
	const killTimer = setTimeout(() => hostAbort.abort(), timeoutSec * 1000 + HOST_GRACE_MS);
	try {
		try {
			container = await docker.createContainer(buildContainerSpec(config, timeoutSec, input.labels));
			await container.start();
		} catch (error) {
			throw unavailable(error, config.image);
		}
		const owner = { uid: CODE_RUNNER_UID, gid: CODE_RUNNER_UID };
		const entries: Array<TarFile | { dir: string }> = [{ dir: "in" }, { dir: "out" }, { name: "main.py", bytes: new TextEncoder().encode(input.code) }];
		for (const file of files) entries.push({ name: `in/${file.name}`, bytes: file.bytes });
		await container.putArchive(packTar(entries, owner), { path: "/work" });
		await container.putArchive(packTar([{ name: ".go", bytes: new Uint8Array(0) }], owner), { path: "/work" });

		const finished = await Promise.race([
			waitForMarker(container, hostAbort.signal),
			new Promise<false>((resolve) => hostAbort.signal.addEventListener("abort", () => resolve(false), { once: true })),
		]);
		const inputNames = files.map((file) => file.name);
		if (!finished) {
			const aborted = hostAbort.signal.aborted;
			return {
				outputs: [], omitted: [], inputNames, exitCode: null, timedOut: aborted, crashed: !aborted, truncated: false, durationMs: Date.now() - started,
				stdout: "", stderr: aborted ? "Tempo esgotado: a execução foi interrompida." : "O processo foi encerrado antes de terminar (provavelmente falta de memória).",
			};
		}
		const result = await readResultJson(container);
		const { outputs, omitted } = await readOutputs(container, config);
		const out = truncateStream(result?.stdout ?? "", config.maxOutputChars);
		const err = truncateStream(result?.stderr ?? "", config.maxOutputChars);
		return {
			exitCode: result?.exit_code ?? null,
			timedOut: result?.timed_out === true,
			stdout: out.text,
			stderr: err.text,
			truncated: out.truncated || err.truncated,
			durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : Date.now() - started,
			outputs, omitted, inputNames,
			crashed: result === null,
		};
	} finally {
		clearTimeout(killTimer);
		input.signal?.removeEventListener("abort", forwardAbort);
		running -= 1;
		if (container) {
			// AutoRemove apaga o container ao morrer; kill/remove aqui só cobrem falhas no meio do caminho.
			await container.kill().catch(() => undefined);
			await container.remove({ force: true, v: true }).catch(() => undefined);
		}
	}
}

/** Remove containers do executor esquecidos (processo morreu no meio, kill falhou). */
export async function reapCodeRunnerContainers(docker: Docker, options: { maxAgeMs?: number; now?: number } = {}): Promise<number> {
	const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
	const now = options.now ?? Date.now();
	let removed = 0;
	let list: Awaited<ReturnType<Docker["listContainers"]>>;
	try {
		list = await docker.listContainers({ all: true, filters: { label: [CODE_RUNNER_LABEL] } });
	} catch {
		return 0;
	}
	for (const item of list) {
		const created = Number(item.Labels?.["atlas.code-runner.created"]) || (item.Created ? item.Created * 1000 : now);
		if (now - created < maxAgeMs) continue;
		try {
			await docker.getContainer(item.Id).remove({ force: true, v: true });
			removed += 1;
		} catch {
			// já removido
		}
	}
	return removed;
}
