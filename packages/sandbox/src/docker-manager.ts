import { assertSandboxExecution, runSandboxOperation, sleepSandbox, SandboxExecutionAbortedError, type SandboxExecutionContext } from "./execution-context.js";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Writable } from "node:stream";
import Docker from "dockerode";
import type { SandboxSessionResponse } from "@workspace/shared";
import type { SandboxRuntimeConfig } from "./config.js";
import {
	controlNavigate,
	controlScreenshot,
	type ControlScreenshotOptions,
	controlClick,
	controlType,
	controlKey,
	controlScroll,
	controlScreen,
	controlBrowserClick,
	controlBrowserType,
	controlBrowserText,
	controlBrowserFind,
	controlBrowserRead,
	controlBrowserSnapshot,
	controlBrowserAct,
	controlBrowserWait,
	controlBrowserLinks,
	controlTabOpen,
	controlTabClose,
	SandboxControlError,
} from "./control-client.js";
import { shouldRecreateForImage } from "./image-staleness.js";
import {
	downloadToSandbox,
	listSandboxDir,
	readSandboxFile,
	runShell,
	SANDBOX_WORK_DIR,
	waitShell,
	writeSandboxFile,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellExecutor,
} from "./shell.js";
import * as sessionStore from "./session-store.js";
import type {
	ControlActParams,
	ControlNavigateResult,
	ControlActResult,
	ControlFindOptions,
	ControlFindResult,
	ControlReadOptions,
	ControlReadResult,
	ControlSnapshotOptions,
	ControlSnapshotResult,
	ControlWaitParams,
	ControlWaitResult,
	ControlActionResult,
	ControlBrowserLinksResult,
	ControlBrowserClickResult,
	ControlBrowserTextOptions,
	ControlBrowserTextResult,
	ControlScrollResult,
	SandboxDownloadResult,
	SandboxWriteFileResult,
	SandboxListResult,
	SandboxReadResult,
	SandboxSessionRecord,
	SandboxShellResult,
	SandboxShellWaitResult,
} from "./types.js";

/** Métodos de shell podem esperar até 600s (timeout do comando) + sobra. */
const LONG_RUNNING_METHODS = new Set(["execShell", "execShellWait", "execDownload", "execWriteFile"]);

/** Single-flight de start por usuario+conversa (com TTL), em memoria do processo. */
const startLocks = new Map<string, { promise: Promise<SandboxSessionResponse>; startedAt: number }>();

const CONTROL_PORT = 3080;
const VIEWER_PORT = 6080;

export class SandboxDockerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxDockerUnavailableError";
	}
}

export function createDockerClient(config: Pick<SandboxRuntimeConfig, "dockerHost" | "dockerSocketPath">): Docker {
	// Fase 0: prefere o proxy do socket (privilégio mínimo) quando DOCKER_HOST
	// está setado (compose); fora do compose cai no socket direto.
	const host = config.dockerHost?.trim();
	if (host) {
		try {
			const url = new URL(host);
			if ((url.protocol === "tcp:" || url.protocol === "http:") && url.hostname) {
				const port = url.port ? Number.parseInt(url.port, 10) : 2375;
				return new Docker({ host: url.hostname, port });
			}
		} catch {
			// URL inválida: cai no socket abaixo (erro claro no primeiro uso).
		}
	}
	return new Docker({ socketPath: config.dockerSocketPath });
}

/** Segundos que o Docker espera o entrypoint fechar o Chrome antes do SIGKILL.
 * Com 5 s o Chrome morria no meio da escrita do perfil (login de sessão perdido,
 * "Restore pages?" na volta). */
export const SANDBOX_STOP_TIMEOUT_S = 15;

function containerName(sessionId: string): string {
	return `atlas-sandbox-${sessionId}`;
}

/** Volume Docker que guarda o perfil do Chrome de uma conversa. Sobrevive
 * ao stop E à remoção do container — é ele que torna o login durável. */
export function profileVolumeName(conversationId: string, userId: string): string {
	const key = createHash("sha256").update(JSON.stringify([userId, conversationId])).digest("hex");
	return `atlas-profile-${key}`;
}

/** Volume do diretório de trabalho do agente (/home/atlas/work): downloads,
 * scripts e saídas sobrevivem a stop/recriação, como o perfil do Chrome. */
export function workVolumeName(conversationId: string, userId: string): string {
	const key = createHash("sha256").update(JSON.stringify([userId, conversationId])).digest("hex");
	return `atlas-work-${key}`;
}

/** Mounts persistentes da conversa: perfil do Chrome + diretório de trabalho. */
export function sandboxBinds(conversationId: string, userId: string): string[] {
	return [
		`${profileVolumeName(conversationId, userId)}:/tmp/chrome-data`,
		`${workVolumeName(conversationId, userId)}:${SANDBOX_WORK_DIR}`,
	];
}

const EXEC_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;

/** docker exec no container; separa stdout/stderr e limita a captura. */
async function dockerExec(container: Docker.Container, modem: Docker["modem"], options: ShellExecOptions): Promise<ShellExecResult> {
	const exec = await container.exec({
		Cmd: options.cmd,
		...(options.stdin ? { AttachStdin: true } : {}),
		AttachStdout: true,
		AttachStderr: true,
		...(options.user ? { User: options.user } : {}),
		...(options.workingDir ? { WorkingDir: options.workingDir } : {}),
		Env: [`HOME=${options.user === "root" ? "/root" : "/home/atlas"}`, ...(options.env ?? [])],
	});
	const stream = await exec.start({ hijack: true, stdin: Boolean(options.stdin) });
	if (options.stdin) stream.end(Buffer.from(options.stdin));
	const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
	const sizes = { out: 0, err: 0 };
	const sink = (key: "out" | "err") =>
		new Writable({
			write(chunk: Buffer, _enc, cb) {
				if (sizes[key] < EXEC_CAPTURE_MAX_BYTES) {
					chunks[key].push(chunk);
					sizes[key] += chunk.length;
				}
				cb();
			},
		});
	await new Promise<void>((resolve, reject) => {
		modem.demuxStream(stream, sink("out"), sink("err"));
		stream.once("end", resolve);
		stream.once("close", resolve);
		stream.once("error", reject);
	});
	const info = await exec.inspect();
	return {
		stdout: Buffer.concat(chunks.out).toString("utf8"),
		stderr: Buffer.concat(chunks.err).toString("utf8"),
		exitCode: info.ExitCode ?? -1,
	};
}

function parsePublishedPort(
	ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined,
	containerPort: string,
): number | null {
	const bindings = ports?.[`${containerPort}/tcp`];
	if (!bindings?.length) return null;
	const hostPort = Number.parseInt(bindings[0]!.HostPort, 10);
	return Number.isFinite(hostPort) ? hostPort : null;
}

type InspectNetworking = {
	NetworkSettings: {
		Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
		Networks?: Record<string, { IPAddress?: string } | undefined>;
	};
};

/** Limites atuais do container diferem da config (env mudou depois de criado)? */
export function resourceLimitsOutdated(
	config: Pick<SandboxRuntimeConfig, "memoryBytes" | "nanoCpus">,
	inspect: { HostConfig?: { Memory?: number; NanoCpus?: number } },
): boolean {
	const host = inspect.HostConfig;
	if (!host) return false;
	return (host.Memory ?? 0) !== config.memoryBytes || (host.NanoCpus ?? 0) !== config.nanoCpus;
}

/** Payload de `docker update`. MemorySwap junto: subir Memory acima do swap
 * já gravado (2x o antigo) falha; 2x mantém o padrão do `create`. */
export function resourceLimitsUpdate(config: Pick<SandboxRuntimeConfig, "memoryBytes" | "nanoCpus">) {
	return {
		Memory: config.memoryBytes,
		MemorySwap: config.memoryBytes * 2,
		NanoCpus: config.nanoCpus,
	};
}

/** Onde a API alcança a VM: IP na rede compartilhada (`network`) ou porta publicada no host. */
export function resolveSandboxEndpoint(
	config: Pick<SandboxRuntimeConfig, "connectMode" | "networkMode" | "controlHost">,
	inspect: InspectNetworking,
): { host: string; viewerPort: number; controlPort: number } | null {
	if (config.connectMode === "network") {
		const ip = inspect.NetworkSettings.Networks?.[config.networkMode]?.IPAddress?.trim();
		return ip ? { host: ip, viewerPort: VIEWER_PORT, controlPort: CONTROL_PORT } : null;
	}
	const viewerPort = parsePublishedPort(inspect.NetworkSettings.Ports, String(VIEWER_PORT));
	const controlPort = parsePublishedPort(inspect.NetworkSettings.Ports, String(CONTROL_PORT));
	if (viewerPort === null || controlPort === null) return null;
	return { host: config.controlHost, viewerPort, controlPort };
}

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resumo post-mortem de um container (docker inspect) para log: a causa real da morte. */
export type ContainerDeathInfo = {
	status?: string;
	exitCode?: number;
	oomKilled?: boolean;
	dead?: boolean;
	error?: string;
	startedAt?: string;
	finishedAt?: string;
	restartCount?: number;
	memoryLimitBytes?: number;
};

export function summarizeContainerDeath(inspect: {
	State?: {
		Status?: string;
		ExitCode?: number;
		OOMKilled?: boolean;
		Dead?: boolean;
		Error?: string;
		StartedAt?: string;
		FinishedAt?: string;
	};
	RestartCount?: number;
	HostConfig?: { Memory?: number };
}): ContainerDeathInfo {
	const state = inspect.State ?? {};
	return {
		status: state.Status,
		exitCode: state.ExitCode,
		oomKilled: state.OOMKilled,
		dead: state.Dead,
		error: state.Error || undefined,
		startedAt: state.StartedAt,
		finishedAt: state.FinishedAt,
		restartCount: inspect.RestartCount,
		memoryLimitBytes: inspect.HostConfig?.Memory,
	};
}

/** Rótulo curto da causa provável (137 sem OOM = SIGKILL externo; 143 = SIGTERM do `docker stop`). */
export function describeDeathCause(info: ContainerDeathInfo): string {
	if (info.oomKilled) return "oom-killed (memória estourou o limite do container)";
	if (info.exitCode === 137) return "SIGKILL externo (docker kill/stop forçado, OOM do host ou reaper)";
	if (info.exitCode === 143) return "SIGTERM (docker stop: reaper ou operador)";
	if (info.exitCode === 127) return "binário ausente no entrypoint";
	if (info.exitCode === 1) return "control server saiu (entrypoint encerrou)";
	if (info.dead) return "container em estado Dead (remoção travada)";
	return "desconhecida";
}

function errorStatusCode(error: unknown): number | undefined {
	return (error as { statusCode?: number } | null)?.statusCode;
}

function logContainerDeath(label: string, info: ContainerDeathInfo): void {
	console.error(
		`[sandbox] container-death ${label} cause="${describeDeathCause(info)}" ${JSON.stringify(info)}`,
	);
}

/** Erro de transporte (VM não respondeu), não resposta HTTP do control server. */
function isTransportError(error: unknown): boolean {
	if (error instanceof SandboxControlError) return false;
	if (error instanceof SandboxExecutionAbortedError) return false;
	return true;
}

/** Erro lançado quando a VM morreu no meio da execução; casa com o mapeamento de sandbox-errors do runtime. */
export class SandboxVmDiedError extends Error {
	constructor(readonly death: ContainerDeathInfo | null) {
		super(
			"Sandbox session not found: a VM parou de responder e a sessão foi encerrada (stopped). Será recriada na próxima ação.",
		);
		this.name = "SandboxVmDiedError";
	}
}

/** Espera o /health com backoff exponencial e prazo total (boot frio passa fácil de 30s). */
async function waitForControlReady(
	host: string,
	port: number,
	context: SandboxExecutionContext = {},
): Promise<void> {
	const totalMs = envPositiveInt("SANDBOX_READY_TIMEOUT_MS", 120_000);
	const baseDelay = envPositiveInt("SANDBOX_READY_DELAY_MS", 500);
	const maxAttempts = envPositiveInt("SANDBOX_READY_ATTEMPTS", Number.MAX_SAFE_INTEGER);
	const startedAt = Date.now();
	let delay = baseDelay;
	let attempts = 0;
	while (attempts < maxAttempts && Date.now() - startedAt < totalMs) {
		attempts += 1;
		assertSandboxExecution(context);
		try {
			const response = await runSandboxOperation(context, 3_000, (signal) => fetch(`http://${host}:${port}/health`, { signal }));
			if (response.ok) return;
		} catch (error) {
			if (error instanceof SandboxExecutionAbortedError && error.reason === "cancel") throw error;
			if (error instanceof SandboxExecutionAbortedError && context.deadlineAtMs !== undefined && Date.now() >= context.deadlineAtMs) throw error;
		}
		await sleepSandbox(context, delay);
		delay = Math.min(Math.round(delay * 1.6), 5_000);
	}
	throw new Error(
		`Sandbox control server did not become ready in time (${attempts} attempts, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
	);
}

/** O controle sobe antes do noVNC; aguarda o viewer aceitar conexões. */
async function waitForViewerReady(host: string, port: number, context: SandboxExecutionContext = {}): Promise<void> {
	const maxAttempts = envPositiveInt("SANDBOX_READY_ATTEMPTS", 60);
	const delay = envPositiveInt("SANDBOX_READY_DELAY_MS", 1000);
	for (let i = 0; i < maxAttempts; i++) {
		assertSandboxExecution(context);
		const ready = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host, port });
			socket.setTimeout(2000);
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => {
				socket.destroy();
				resolve(false);
			});
			socket.once("timeout", () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (ready) return;
		await sleepSandbox(context, delay);
	}
	throw new Error(
		`Sandbox viewer did not become ready in time (${maxAttempts} attempts)`,
	);
}

/** URL do noVNC: direta (porta do host) ou via proxy autenticado da API. */
export function buildViewerUrl(
	config: Pick<SandboxRuntimeConfig, "viewerHost" | "viewerMode">,
	sessionId: string,
	viewerPort: number,
): string {
	if (config.viewerMode === "proxy") {
		const base = `v1/sandbox/sessions/${encodeURIComponent(sessionId)}/viewer`;
		// `path` é o caminho do websockify que o noVNC usa (relativo à origem).
		return `/${base}/vnc.html?autoconnect=1&reconnect=true&resize=scale&path=${encodeURIComponent(`${base}/websockify`)}`;
	}
	return `${config.viewerHost}:${viewerPort}/vnc.html?autoconnect=true&reconnect=true&resize=scale`;
}

function toResponse(
	record: SandboxSessionRecord,
	config: SandboxRuntimeConfig,
): SandboxSessionResponse {
	return {
		sessionId: record.sessionId,
		conversationId: record.conversationId,
		status: record.status,
		viewerUrl: buildViewerUrl(config, record.sessionId, record.viewerPort),
		createdAt: record.createdAt.toISOString(),
	};
}

export type SandboxManager = {
	withExecutionContext?: (context: SandboxExecutionContext) => SandboxManager;
	createSession: (conversationId?: string) => Promise<SandboxSessionResponse>;
	/** Reusa (ou reinicia) o mesmo sandbox da conversa; cria se não existir. */
	resolveSession: (conversationId?: string) => Promise<SandboxSessionResponse>;
	/** Retorna o sandbox ativo da conversa (religa se parado) ou null. Não cria. */
	getSessionForConversation: (
		conversationId: string,
		options?: { wake?: boolean },
	) => Promise<SandboxSessionResponse | null>;
	getSession: (sessionId: string) => Promise<SandboxSessionResponse | null>;
	/** Confere posse entre processos sem iniciar ou substituir o container. */
	getOwnedSessionMetadata: (sessionId: string) => Promise<SandboxSessionResponse | null>;
	destroySession: (sessionId: string) => Promise<boolean>;
	/** Para o container sem removê-lo (preserva o estado p/ religar depois). */
	stopSession: (sessionId: string) => Promise<boolean>;
	/** Desliga (graciosamente) a VM ligada da conversa, sem criar nem ligar nada. false = não havia VM ligada. */
	stopConversationSession: (conversationId: string) => Promise<boolean>;
	getViewerUrl: (sessionId: string) => string | null;
	/** Destino (host/porta publicada) do noVNC da sessão do dono, para o proxy da API. */
	resolveViewerTarget: (sessionId: string) => Promise<{ host: string; port: number; tls: boolean } | null>;
	execNavigate: (sessionId: string, url: string) => Promise<ControlNavigateResult>;
	execScreenshot: (
		sessionId: string,
		options?: ControlScreenshotOptions,
	) => Promise<Buffer>;
	execScreen: (sessionId: string) => Promise<{ width: number; height: number }>;
	execClick: (sessionId: string, x: number, y: number) => Promise<ControlActionResult>;
	execType: (sessionId: string, text: string) => Promise<ControlActionResult>;
	execKey: (sessionId: string, combo: string) => Promise<ControlActionResult>;
	execScroll: (
		sessionId: string,
		deltaX: number,
		deltaY: number,
	) => Promise<ControlScrollResult>;
	execBrowserClick: (
		sessionId: string,
		params: { selector?: string; text?: string },
	) => Promise<ControlBrowserClickResult>;
	execBrowserType: (
		sessionId: string,
		params: { selector?: string; text: string; submit?: boolean },
	) => Promise<ControlActionResult>;
	execBrowserText: (
		sessionId: string,
		options?: ControlBrowserTextOptions,
	) => Promise<ControlBrowserTextResult>;
	execBrowserLinks: (sessionId: string) => Promise<ControlBrowserLinksResult>;
	execBrowserSnapshot: (
		sessionId: string,
		options?: ControlSnapshotOptions,
	) => Promise<ControlSnapshotResult>;
	execBrowserAct: (sessionId: string, params: ControlActParams) => Promise<ControlActResult>;
	execBrowserWait: (sessionId: string, params: ControlWaitParams) => Promise<ControlWaitResult>;
	execBrowserRead: (sessionId: string, options?: ControlReadOptions) => Promise<ControlReadResult>;
	execBrowserFind: (sessionId: string, options: ControlFindOptions) => Promise<ControlFindResult>;
	/** V8: abre uma aba própria (mesmo perfil/login) e devolve o id; use `withExecutionContext({ tabId })` para agir nela. */
	execTabOpen: (sessionId: string, url?: string) => Promise<{ tabId: string }>;
	execTabClose: (sessionId: string, tabId: string) => Promise<{ closed: boolean }>;
	/** Shell DENTRO do container (usuário não-root `atlas`), nunca no host. */
	execShell: (
		sessionId: string,
		params: { command: string; cwd?: string; timeoutS?: number; background?: boolean },
	) => Promise<SandboxShellResult>;
	execShellWait: (
		sessionId: string,
		params: { jobId: string; timeoutS?: number; offset?: number },
	) => Promise<SandboxShellWaitResult>;
	execReadFile: (sessionId: string, params: { path: string; offset?: number; limit?: number }) => Promise<SandboxReadResult>;
	execListDir: (sessionId: string, params: { path: string }) => Promise<SandboxListResult>;
	/** Copia bytes (ex.: anexo do usuário) para um arquivo dentro da VM. */
	execWriteFile?: (sessionId: string, params: { path: string; bytes: Uint8Array }) => Promise<SandboxWriteFileResult>;
	execDownload: (
		sessionId: string,
		params: { url: string; path?: string; useBrowserSession?: boolean },
	) => Promise<SandboxDownloadResult>;
	/** Apaga o volume do perfil do Chrome da conversa (logins/cookies). Recria a VM no próximo uso. */
	clearBrowserProfile: (conversationId: string) => Promise<{ cleared: boolean; removedContainers: number }>;
};

export function createSandboxManager(
	config: SandboxRuntimeConfig,
	userId: string,
	context: SandboxExecutionContext = {},
): SandboxManager {
	if (!userId?.trim() || userId === "default") throw new Error("Sandbox owner required");
	let docker: Docker | null = null;

	function getDocker(): Docker {
		assertSandboxExecution(context);
		if (!config.enabled) {
			throw new SandboxDockerUnavailableError(
				"Sandbox disabled (set SANDBOX_ENABLED=true)",
			);
		}
		if (!docker) {
			docker = createDockerClient(config);
		}
		return docker;
	}

	function getRecord(sessionId: string): SandboxSessionRecord {
		const record = sessionStore.getSession(sessionId, userId);
		if (!record) {
			throw new Error(`Sandbox session not found: ${sessionId}`);
		}
		sessionStore.touchSession(sessionId, userId);
		return record;
	}

	function shellExecutor(sessionId: string): ShellExecutor {
		const record = getRecord(sessionId);
		if (record.status !== "running" || !(record.containerId || record.containerName)) {
			throw new Error(`Sandbox session not found or not running: ${sessionId}`);
		}
		const client = getDocker();
		const container = client.getContainer(record.containerId || record.containerName);
		return (options) => dockerExec(container, client.modem, options);
	}

	const manager: SandboxManager = {
		async createSession(conversationId?: string) {
			return startWithRetries(conversationId, { replaceExisting: false });
		},

		async resolveSession(conversationId) {
			const resolved = await resolveExisting(conversationId);
			return resolved ?? startWithRetries(conversationId, { replaceExisting: true });
		},

		getSessionForConversation(conversationId, options = {}) {
			// Caminho só-leitura (API/painel): nunca recria/para/remove container Running.
			// `wake:false` (poll do painel) também não religa a VM parada: sem isso o painel
			// aberto desfazia o "Desligar" e o guarda de memória a cada 15 s.
			return resolveExisting(conversationId, { readOnly: true, ...(options.wake === false ? { noStart: true } : {}) });
		},

		async getSession(sessionId) {
			const record = sessionStore.getSession(sessionId, userId) ?? await adoptBySessionId(sessionId);
			if (!record) return null;
			if (record.status !== "running" || !record.containerId) {
				return toResponse(record, config);
			}
			sessionStore.touchSession(sessionId, userId);
			try {
				const client = getDocker();
				const container = client.getContainer(record.containerId);
				const inspect = await container.inspect();
				if (!inspect.State.Running) {
					record.status = "stopped";
					sessionStore.putSession(record);
				}
			} catch {
				record.status = "stopped";
				sessionStore.deleteSession(sessionId, userId);
				return null;
			}
			return toResponse(record, config);
		},

		async destroySession(sessionId) {
			const record = sessionStore.getSession(sessionId, userId);
			if (!record) return false;
			try {
				const client = getDocker();
				const ref = record.containerId || record.containerName;
				const container = client.getContainer(ref);
				await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
				await container.remove({ force: true }).catch(() => undefined);
			} catch {
				// container may already be gone (AutoRemove)
			}
			sessionStore.deleteSession(sessionId, userId);
			return true;
		},

		async getOwnedSessionMetadata(sessionId) {
			const record = sessionStore.getSession(sessionId, userId) ?? await adoptBySessionId(sessionId);
			return record ? toResponse(record, config) : null;
		},

		async stopConversationSession(conversationId) {
			try {
				const client = getDocker();
				const containers = await client.listContainers({
					all: false,
					filters: { label: ["atlas.sandbox=true", `atlas.sandbox.conversationId=${conversationId}`, `atlas.sandbox.userId=${userId}`] },
				});
				const mine = containers.filter(
					(item) => item.Labels?.["atlas.sandbox.userId"] === userId && item.Labels?.["atlas.sandbox.conversationId"] === conversationId,
				);
				for (const item of mine) await client.getContainer(item.Id).stop({ t: SANDBOX_STOP_TIMEOUT_S });
				const known = sessionStore.findByConversationId(conversationId, userId);
				if (known) {
					known.status = "stopped";
					sessionStore.putSession(known);
				}
				return mine.length > 0;
			} catch {
				return false;
			}
		},

		async stopSession(sessionId) {
			const record = sessionStore.getSession(sessionId, userId) ?? await adoptBySessionId(sessionId);
			if (!record) return false;
			try {
				const client = getDocker();
				const container = client.getContainer(
					record.containerId || record.containerName,
				);
				await container.stop({ t: SANDBOX_STOP_TIMEOUT_S });
				record.status = "stopped";
				sessionStore.putSession(record);
				return true;
			} catch {
				return false;
			}
		},

		getViewerUrl(sessionId) {
			const record = sessionStore.getSession(sessionId, userId);
			if (!record || record.viewerPort === 0) return null;
			return buildViewerUrl(config, record.sessionId, record.viewerPort);
		},

		async resolveViewerTarget(sessionId) {
			// O store em memória pode estar velho (IP de container removido reaproveitado
			// por outro): confere no Docker label sessionId/userId + Running e usa o endpoint atual.
			try {
				const inspect = await getDocker()
					.getContainer(
						sessionStore.getSession(sessionId, userId)?.containerId ||
							(await adoptBySessionId(sessionId))?.containerId ||
							"",
					)
					.inspect();
				const labels = inspect.Config?.Labels ?? {};
				if (
					!inspect.State?.Running ||
					labels["atlas.sandbox.sessionId"] !== sessionId ||
					labels["atlas.sandbox.userId"] !== userId
				) {
					sessionStore.deleteSession(sessionId, userId);
					return null;
				}
				const endpoint = resolveSandboxEndpoint(config, inspect);
				if (!endpoint || endpoint.viewerPort === 0) return null;
				return { host: endpoint.host ?? config.controlHost, port: endpoint.viewerPort, tls: config.viewerTls };
			} catch {
				return null;
			}
		},

		async execNavigate(sessionId, url) {
			const record = getRecord(sessionId);
			return controlNavigate(record.host ?? config.controlHost, record.controlPort, url, context);
		},

		async execScreenshot(sessionId, options) {
			const record = getRecord(sessionId);
			return controlScreenshot(record.host ?? config.controlHost, record.controlPort, options, context);
		},

		async execScreen(sessionId) {
			const record = getRecord(sessionId);
			return controlScreen(record.host ?? config.controlHost, record.controlPort, context);
		},

		async execClick(sessionId, x, y) {
			const record = getRecord(sessionId);
			return controlClick(record.host ?? config.controlHost, record.controlPort, x, y, context);
		},

		async execType(sessionId, text) {
			const record = getRecord(sessionId);
			return controlType(record.host ?? config.controlHost, record.controlPort, text, context);
		},

		async execKey(sessionId, combo) {
			const record = getRecord(sessionId);
			return controlKey(record.host ?? config.controlHost, record.controlPort, combo, context);
		},

		async execScroll(sessionId, deltaX, deltaY) {
			const record = getRecord(sessionId);
			return controlScroll(
				record.host ?? config.controlHost,
				record.controlPort,
				deltaX,
				deltaY, context);
		},

		async execBrowserClick(sessionId, params) {
			const record = getRecord(sessionId);
			return controlBrowserClick(record.host ?? config.controlHost, record.controlPort, params, context);
		},

		async execBrowserType(sessionId, params) {
			const record = getRecord(sessionId);
			return controlBrowserType(record.host ?? config.controlHost, record.controlPort, params, context);
		},

		async execBrowserText(sessionId, options) {
			const record = getRecord(sessionId);
			return controlBrowserText(record.host ?? config.controlHost, record.controlPort, options, context);
		},

		async execBrowserSnapshot(sessionId, options) {
			const record = getRecord(sessionId);
			return controlBrowserSnapshot(record.host ?? config.controlHost, record.controlPort, options, context);
		},

		async execBrowserAct(sessionId, params) {
			const record = getRecord(sessionId);
			return controlBrowserAct(record.host ?? config.controlHost, record.controlPort, params, context);
		},

		async execBrowserRead(sessionId, options) {
			const record = getRecord(sessionId);
			return controlBrowserRead(record.host ?? config.controlHost, record.controlPort, options, context);
		},

		async execBrowserFind(sessionId, options) {
			const record = getRecord(sessionId);
			return controlBrowserFind(record.host ?? config.controlHost, record.controlPort, options, context);
		},

		async execBrowserWait(sessionId, params) {
			const record = getRecord(sessionId);
			return controlBrowserWait(record.host ?? config.controlHost, record.controlPort, params, context);
		},

		async execTabOpen(sessionId, url) {
			const record = getRecord(sessionId);
			return controlTabOpen(record.host ?? config.controlHost, record.controlPort, url, context);
		},

		async execTabClose(sessionId, tabId) {
			const record = getRecord(sessionId);
			return controlTabClose(record.host ?? config.controlHost, record.controlPort, tabId, context);
		},

		async execShell(sessionId, params) {
			return runShell(shellExecutor(sessionId), params);
		},

		async execShellWait(sessionId, params) {
			return waitShell(shellExecutor(sessionId), params);
		},

		async execReadFile(sessionId, params) {
			return readSandboxFile(shellExecutor(sessionId), params);
		},

		async execListDir(sessionId, params) {
			return listSandboxDir(shellExecutor(sessionId), params);
		},

		async execWriteFile(sessionId, params) {
			return writeSandboxFile(shellExecutor(sessionId), params);
		},

		async execDownload(sessionId, params) {
			return downloadToSandbox(shellExecutor(sessionId), params);
		},

		async clearBrowserProfile(conversationId) {
			const client = getDocker();
			let removedContainers = 0;
			// O volume só sai com o container removido; `v: false` mantém os volumes anônimos/de trabalho.
			const containers = await client.listContainers({
				all: true,
				filters: { label: ["atlas.sandbox=true", `atlas.sandbox.conversationId=${conversationId}`, `atlas.sandbox.userId=${userId}`] },
			});
			for (const item of containers) {
				if (item.Labels?.["atlas.sandbox.userId"] !== userId || item.Labels?.["atlas.sandbox.conversationId"] !== conversationId) continue;
				const container = client.getContainer(item.Id);
				await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
				await container.remove({ force: true, v: false });
				removedContainers += 1;
			}
			const known = sessionStore.findByConversationId(conversationId, userId);
			if (known) sessionStore.deleteSession(known.sessionId, userId);
			try {
				await client.getVolume(profileVolumeName(conversationId, userId)).remove({ force: true });
			} catch (error) {
				if ((error as { statusCode?: number }).statusCode !== 404) throw error;
			}
			return { cleared: true, removedContainers };
		},

		async execBrowserLinks(sessionId) {
			const record = getRecord(sessionId);
			return controlBrowserLinks(record.host ?? config.controlHost, record.controlPort, context);
		},
	};

	async function startOnce(conversationId: string | undefined, opts: { replaceExisting: boolean }): Promise<SandboxSessionResponse> {
			const client = getDocker();
			const sessionId = randomUUID();
			const name = containerName(sessionId);
	
			const record: SandboxSessionRecord = {
				userId,
				sessionId,
				conversationId,
				containerId: "",
				containerName: name,
				status: "starting",
				viewerPort: 0,
				controlPort: 0,
				createdAt: new Date(),
				lastUsedAt: new Date(),
			};
			sessionStore.putSession(record);
	
		try {
			const profileVolume =
				config.profileVolumes && conversationId
					? profileVolumeName(conversationId, userId)
					: null;
			if (conversationId) await removeLeftovers(client, conversationId, { includeRunning: opts.replaceExisting });
			const container = await client.createContainer({
				Image: config.image,
				name,
				Env: [`SANDBOX_TLS=${config.viewerTls ? "true" : "false"}`],
				Labels: {
					"atlas.sandbox": "true",
					"atlas.sandbox.userId": userId,
					"atlas.sandbox.sessionId": sessionId,
					...(conversationId
						? { "atlas.sandbox.conversationId": conversationId }
						: {}),
				},
				HostConfig: {
					// tini como PID 1: repassa SIGTERM ao entrypoint (que fecha o Chrome
					// direito) e colhe processos zumbis.
					Init: true,
					Memory: config.memoryBytes,
					NanoCpus: config.nanoCpus,
					NetworkMode: config.networkMode,
					// Modo `network`: nada publicado no host; a API usa o IP interno.
					...(config.connectMode === "network"
						? {}
						: {
								PortBindings: {
									[`${VIEWER_PORT}/tcp`]: [{ HostIp: "127.0.0.1" }],
									[`${CONTROL_PORT}/tcp`]: [{ HostIp: "127.0.0.1" }],
								},
							}),
					// O Docker cria o volume nomeado no primeiro mount; nas
					// próximas criações da mesma conversa, o perfil (cookies,
					// logins, storage) já está lá. O remove do container NÃO
					// apaga o volume.
					...(profileVolume && conversationId
						? { Binds: sandboxBinds(conversationId, userId) }
						: {}),
				},
				ExposedPorts: {
					[`${VIEWER_PORT}/tcp`]: {},
					[`${CONTROL_PORT}/tcp`]: {},
				},
			});
			if (profileVolume) {
				console.log(
					`[sandbox] session ${sessionId} using profile volume ${profileVolume}`,
				);
			}
	
				assertSandboxExecution(context);
				await container.start();
				const inspect = await container.inspect();
				const endpoint = resolveSandboxEndpoint(config, inspect);
				if (!endpoint) {
					throw new Error(
						config.connectMode === "network"
							? `Sandbox sem IP na rede "${config.networkMode}" (SANDBOX_NETWORK_MODE)`
							: "Failed to resolve published sandbox ports",
					);
				}
				const { host, viewerPort, controlPort } = endpoint;
	
				await waitForControlReady(host, controlPort, context);
				await waitForViewerReady(host, viewerPort, context);
	
				const running: SandboxSessionRecord = {
					...record,
					containerId: inspect.Id,
					status: "running",
					viewerPort,
					controlPort,
					host,
				};
				sessionStore.putSession(running);
				return toResponse(running, config);
			} catch (error) {
				record.status = "error";
				sessionStore.putSession(record);
				try {
					const c = client.getContainer(name);
					await recordDeath(c, name);
					await c.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
					await c.remove({ force: true }).catch(() => undefined);
				} catch {
					// ignore cleanup errors
				}
				sessionStore.deleteSession(sessionId, userId);
				if (error instanceof SandboxDockerUnavailableError) {
					throw error;
				}
				const message =
					error instanceof Error ? error.message : "Unknown docker error";
				throw new SandboxDockerUnavailableError(
					`Failed to start sandbox container: ${message}`,
				);
			}
	}


	/** Lê o estado final do container e grava a causa no log (exit code, OOMKilled...). Nunca lança. */
	async function recordDeath(container: Docker.Container, label: string): Promise<ContainerDeathInfo | null> {
		try {
			const inspect = await container.inspect();
			const info = summarizeContainerDeath(inspect);
			if (!inspect.State.Running) logContainerDeath(label, info);
			return info;
		} catch (error) {
			if (errorStatusCode(error) === 404) {
				console.error(`[sandbox] container-death ${label} cause="container removido (sem inspect)"`);
			}
			return null;
		}
	}

	/**
	 * Remove containers da conversa que impediriam um start limpo: Exited/Dead/Created
	 * (prendem o volume do perfil e confundem a adocao) e, com includeRunning, tambem
	 * os "rodando" sem saude (a adocao ja falhou). Volumes ficam (v:false).
	 * Tambem solta endpoints de rede orfaos. Best-effort: nunca lanca.
	 */
	async function removeLeftovers(
		client: Docker,
		conversationId: string,
		options: { includeRunning: boolean },
	): Promise<number> {
		let removed = 0;
		try {
			const containers = await client.listContainers({
				all: true,
				filters: { label: ["atlas.sandbox=true", `atlas.sandbox.conversationId=${conversationId}`, `atlas.sandbox.userId=${userId}`] },
			});
			for (const item of containers) {
				if (item.Labels?.["atlas.sandbox.userId"] !== userId || item.Labels?.["atlas.sandbox.conversationId"] !== conversationId) continue;
				const live = item.State === "running" || item.State === "restarting" || item.State === "paused";
				if (live && !options.includeRunning) continue;
				const ref = client.getContainer(item.Id);
				const label = (item.Names?.[0] ?? item.Id).replace(/^\//, "");
				if (!live) await recordDeath(ref, label);
				try {
					if (live) await ref.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
					await ref.remove({ force: true, v: false });
					removed += 1;
					console.warn(`[sandbox] removed leftover container ${label} state=${item.State ?? "?"}`);
				} catch (error) {
					if (errorStatusCode(error) !== 404) {
						console.warn(`[sandbox] could not remove leftover ${label}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			await dropStaleEndpoints(client, new Set(containers.map((item) => item.Id)));
		} catch (error) {
			console.warn(`[sandbox] leftover cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
		return removed;
	}

	/** Endpoints atlas-sandbox-* na rede compartilhada cujo container sumiu (impedem reconexao). */
	async function dropStaleEndpoints(client: Docker, knownIds: Set<string>): Promise<void> {
		if (config.networkMode === "bridge" || config.networkMode === "none" || config.networkMode === "host") return;
		try {
			const network = client.getNetwork(config.networkMode);
			const info = (await network.inspect()) as { Containers?: Record<string, { Name?: string }> };
			for (const [id, endpoint] of Object.entries(info.Containers ?? {})) {
				if (!endpoint.Name?.startsWith("atlas-sandbox-") || knownIds.has(id)) continue;
				await network.disconnect({ Container: id, Force: true }).catch(() => undefined);
				console.warn(`[sandbox] dropped stale network endpoint ${endpoint.Name}`);
			}
		} catch {
			// rede inexistente ou sem permissao: segue sem limpar
		}
	}

	const START_RETRIES = 2;
	const START_LOCK_TTL_MS = 5 * 60_000;

	/** Start idempotente: 1 tentativa + ate 2 retries com container novo; single-flight por conversa com TTL. */
	async function startWithRetries(
		conversationId: string | undefined,
		opts: { replaceExisting: boolean },
	): Promise<SandboxSessionResponse> {
		const key = `${userId}|${conversationId ?? ""}`;
		const lock = conversationId ? startLocks.get(key) : undefined;
		if (lock && Date.now() - lock.startedAt < START_LOCK_TTL_MS) {
			try {
				return await lock.promise;
			} catch {
				// a tentativa do outro chamador falhou/foi abortada: tenta a propria
			}
		}
		const run = (async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
				assertSandboxExecution(context);
				try {
					return await startOnce(conversationId, opts);
				} catch (error) {
					lastError = error;
					if (error instanceof SandboxExecutionAbortedError) throw error;
					const message = error instanceof Error ? error.message : String(error);
					if (/disabled/i.test(message)) throw error;
					console.error(
						`[sandbox] start attempt ${attempt + 1}/${START_RETRIES + 1} failed conversation=${conversationId ?? "-"}: ${message}`,
					);
				}
			}
			throw lastError;
		})();
		if (conversationId) {
			const entry = { promise: run, startedAt: Date.now() };
			startLocks.set(key, entry);
			void run
				.catch(() => undefined)
				.then(() => {
					if (startLocks.get(key) === entry) startLocks.delete(key);
				});
		}
		return run;
	}

	/** A VM sumiu no meio da execucao? Marca a sessao como parada (nao "running") e registra a causa. */
	async function markDeadIfGone(sessionId: string): Promise<ContainerDeathInfo | null | undefined> {
		const record = sessionStore.getSession(sessionId, userId);
		if (!record) return undefined;
		const label = record.containerName || record.containerId;
		try {
			const inspect = await getDocker().getContainer(record.containerId || record.containerName).inspect();
			if (inspect.State.Running) return undefined;
			const info = summarizeContainerDeath(inspect);
			logContainerDeath(label, info);
			record.status = "stopped";
			sessionStore.putSession(record);
			return info;
		} catch (error) {
			if (errorStatusCode(error) === 404) {
				console.error(`[sandbox] container-death ${label} cause="container removido do Docker"`);
				record.status = "stopped";
				sessionStore.putSession(record);
				return null;
			}
			return undefined;
		}
	}

	/** Reinicia o container (se parado) e atualiza a sessão com portas frescas. */
	async function ensureRunning(
		record: SandboxSessionRecord,
		options: { replaceRunningIfOutdated?: boolean; readOnly?: boolean; noStart?: boolean } = {},
	): Promise<SandboxSessionRecord | null> {
		try {
			const client = getDocker();
			const container = client.getContainer(
				record.containerId || record.containerName,
			);
			let inspect = await container.inspect();
			// Poll do painel: VM parada (de propósito) continua parada.
			if (options.noStart && !inspect.State.Running) return null;
			// Só troca a imagem na hora de subir/adotar: container parado, ou
			// rodando mas sem sessão neste processo (options). Nunca derruba um
			// container que uma sessão viva deste processo está usando.
			if (
				record.conversationId &&
				(!inspect.State.Running || options.replaceRunningIfOutdated) &&
				(await isImageOutdated(client, inspect.Image))
			) {
				const fresh = await recreateFromCurrentImage(
					client,
					container,
					record,
					inspect.State.Running,
				);
				if (fresh) return fresh;
			}
			// RAM/CPU mudaram no env (SANDBOX_MEMORY_MB/SANDBOX_CPUS): aplica no
			// container reaproveitado; sem isso a VM fica com o limite antigo.
			if (resourceLimitsOutdated(config, inspect)) {
				const label = record.containerName || record.containerId;
				try {
					await container.update(resourceLimitsUpdate(config));
					console.log(
						`[sandbox] limits of ${label} updated: memory=${config.memoryBytes} nanoCpus=${config.nanoCpus}`,
					);
				} catch (error) {
					console.warn(
						`[sandbox] could not update limits of ${label}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			if (!inspect.State.Running) {
				assertSandboxExecution(context);
				if (inspect.State.Dead || inspect.State.Status === "removing") {
					// Dead nao religa: remove (volume fica) e deixa o start criar outro.
					logContainerDeath(record.containerName || record.containerId, summarizeContainerDeath(inspect));
					await container.remove({ force: true, v: false }).catch(() => undefined);
					return null;
				}
				if (inspect.State.Status === "exited") logContainerDeath(record.containerName || record.containerId, summarizeContainerDeath(inspect));
				await container.start();
				inspect = await container.inspect();
			}
			const endpoint = resolveSandboxEndpoint(config, inspect);
			if (!endpoint) throw new Error("sandbox sem endpoint (IP/porta) apos start");
			const { host, viewerPort, controlPort } = endpoint;
			await waitForControlReady(host, controlPort, context);
			await waitForViewerReady(host, viewerPort, context);
			const running: SandboxSessionRecord = {
				...record,
				containerId: inspect.Id,
				status: "running",
				viewerPort,
				controlPort,
				host,
				lastUsedAt: new Date(),
			};
			sessionStore.putSession(running);
			return running;
		} catch (error) {
			if (error instanceof SandboxExecutionAbortedError) throw error;
			const label = record.containerName || record.containerId;
			console.error(
				`[sandbox] could not bring up existing container ${label}: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Container que nao sobe / nao responde segura o volume do perfil: remove para o start criar um novo.
			try {
				const c = getDocker().getContainer(record.containerId || record.containerName);
				if (options.readOnly) {
					// API só lê: não derruba VM Running que o worker pode estar subindo/usando.
					const state = await c.inspect().catch(() => null);
					if (state?.State?.Running) {
						console.warn(`[sandbox] read-only: keeping running container ${label} (not removed)`);
						return null;
					}
				}
				await recordDeath(c, label);
				await c.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
				await c.remove({ force: true, v: false });
			} catch {
				// ja removido ou Docker indisponivel
			}
			return null;
		}
	}

	/** Compara o ID da imagem do container com o da imagem atual da config.
	 * Se não der para inspecionar, assume "não desatualizada" (reusa) e loga. */
	async function isImageOutdated(
		client: Docker,
		containerImageId: string,
	): Promise<boolean> {
		try {
			const current = await client.getImage(config.image).inspect();
			return shouldRecreateForImage(containerImageId, current.Id);
		} catch (error) {
			console.warn(
				`[sandbox] could not inspect image ${config.image}; reusing container: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
	}

	/** Remove o container velho (sem `v`: o volume de perfil fica) e cria um
	 * novo da imagem atual; `createSession` remonta o mesmo atlas-profile-<id>.
	 * Falha ao remover → null (quem chamou segue reusando o container). */
	async function recreateFromCurrentImage(
		client: Docker,
		container: Docker.Container,
		record: SandboxSessionRecord,
		running: boolean,
	): Promise<SandboxSessionRecord | null> {
		console.log(
			`[sandbox] image of ${record.containerName || record.containerId} is outdated; recreating (profile volume kept)`,
		);
		try {
			if (running) await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => undefined);
			await container.remove({ force: true, v: false });
		} catch (error) {
			console.warn(
				`[sandbox] could not remove outdated container; reusing it: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
		sessionStore.deleteSession(record.sessionId, userId);
		const created = await manager.createSession(record.conversationId);
		return sessionStore.getSession(created.sessionId, userId) ?? null;
	}

	/** Acha um container de sandbox da conversa por label (sobrevive a restart). */
	async function adoptByLabel(
		conversationId: string,
		options: { readOnly?: boolean; noStart?: boolean } = {},
	): Promise<SandboxSessionRecord | null> {
		try {
			const client = getDocker();
			const containers = await client.listContainers({
				all: true,
				filters: {
					label: [
						"atlas.sandbox=true",
						`atlas.sandbox.conversationId=${conversationId}`,
						`atlas.sandbox.userId=${userId}`,
					],
				},
			});
			// Mais de um container na conversa: escolha determinística, o mais recente (Created).
			const found = containers
				.filter((item) => item.Labels?.["atlas.sandbox.userId"] === userId && item.Labels?.["atlas.sandbox.conversationId"] === conversationId)
				.sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0))[0];
			if (!found) return null;
			const record: SandboxSessionRecord = {
				userId,
				sessionId: found.Labels?.["atlas.sandbox.sessionId"] ?? randomUUID(),
				conversationId,
				containerId: found.Id,
				containerName: (found.Names?.[0] ?? "").replace(/^\//, ""),
				status: "starting",
				viewerPort: 0,
				controlPort: 0,
				createdAt: new Date(),
				lastUsedAt: new Date(),
			};
			// Adoção (ex.: após restart): este processo não tem sessão viva do
			// container, então pode trocar até um que esteja rodando.
			return await ensureRunning(record, options.readOnly ? { readOnly: true, ...(options.noStart ? { noStart: true } : {}) } : { replaceRunningIfOutdated: true });
		} catch {
			return null;
		}
	}

	async function resolveExisting(
		conversationId?: string,
		options: { readOnly?: boolean; noStart?: boolean } = {},
	): Promise<SandboxSessionResponse | null> {
		if (!conversationId) return null;
		const existing = sessionStore.findByConversationId(conversationId, userId);
		if (existing) {
			const running = await ensureRunning(existing, { ...(options.readOnly ? { readOnly: true } : {}), ...(options.noStart ? { noStart: true } : {}) });
			if (running) return toResponse(running, config);
			sessionStore.deleteSession(existing.sessionId, userId);
		}
		const adopted = await adoptByLabel(conversationId, options);
		return adopted ? toResponse(adopted, config) : null;
	}

	/** Recupera a sessão de outro processo sem confiar somente no UUID. */
	async function adoptBySessionId(sessionId: string): Promise<SandboxSessionRecord | null> {
		try {
			const containers = await getDocker().listContainers({ all: true, filters: { label: [
				"atlas.sandbox=true", `atlas.sandbox.sessionId=${sessionId}`, `atlas.sandbox.userId=${userId}`,
			] } });
			const found = containers.find((item) => item.Labels?.["atlas.sandbox.userId"] === userId && item.Labels?.["atlas.sandbox.sessionId"] === sessionId);
			if (!found) return null;
			const inspect = await getDocker().getContainer(found.Id).inspect();
			const record: SandboxSessionRecord = {
				userId, sessionId, conversationId: found.Labels?.["atlas.sandbox.conversationId"],
				containerId: found.Id, containerName: (found.Names?.[0] ?? "").replace(/^\//, ""),
				status: inspect.State.Running ? "running" : "stopped",
				...(() => {
					const endpoint = resolveSandboxEndpoint(config, inspect);
					return endpoint ?? { viewerPort: 0, controlPort: 0 };
				})(),
				createdAt: new Date(), lastUsedAt: new Date(),
			};
			sessionStore.putSession(record);
			return record;
		} catch { return null; }
	}

	manager.withExecutionContext = (execution) => createSandboxManager(config, userId, execution);
	return new Proxy(manager, {
		get(target, key) {
			const method = Reflect.get(target, key);
			if (typeof method !== "function" || key === "getViewerUrl" || key === "withExecutionContext") return method;
			const timeoutMs = typeof key === "string" && LONG_RUNNING_METHODS.has(key) ? 700_000 : 180_000;
			const isExec = typeof key === "string" && key.startsWith("exec");
			return (...args: unknown[]) =>
				runSandboxOperation(context, timeoutMs, async () => {
					try {
						return await method(...args);
					} catch (error) {
						if (!isExec || !isTransportError(error) || typeof args[0] !== "string") throw error;
						// VM inalcancavel: confirma no Docker; se morreu, marca a sessao como parada.
						const death = await markDeadIfGone(args[0]);
						if (death === undefined) throw error;
						throw new SandboxVmDiedError(death);
					}
				});
		},
	});
}

export { SandboxControlError };
