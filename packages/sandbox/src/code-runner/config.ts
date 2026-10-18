export const CODE_RUNNER_DEFAULT_IMAGE = "atlas-code-runner:latest";
export const CODE_RUNNER_LABEL = "atlas.code-runner";
/** uid/gid do usuário da imagem (docker/code-runner/Dockerfile). */
export const CODE_RUNNER_UID = 10001;

export type CodeRunnerConfig = {
	enabled: boolean;
	image: string;
	memoryBytes: number;
	nanoCpus: number;
	pidsLimit: number;
	defaultTimeoutSec: number;
	maxTimeoutSec: number;
	maxConcurrent: number;
	/** Entrada: arquivos e bytes totais copiados para /work/in. */
	maxInputFiles: number;
	maxInputBytes: number;
	/** Saída: arquivos e bytes totais lidos de /work/out. */
	maxOutputFiles: number;
	maxOutputBytes: number;
	/** Cada fluxo (stdout/stderr) devolvido ao modelo. */
	maxOutputChars: number;
	dockerHost: string;
	dockerSocketPath: string;
};

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
	const value = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function loadCodeRunnerConfig(env: NodeJS.ProcessEnv = process.env): CodeRunnerConfig {
	const flag = env.CODE_RUNNER_ENABLED?.trim().toLowerCase();
	const socket = env.DOCKER_SOCKET_PATH?.trim() || (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock");
	return {
		enabled: flag === undefined || flag === "" ? true : flag === "1" || flag === "true",
		image: env.CODE_RUNNER_IMAGE?.trim() || CODE_RUNNER_DEFAULT_IMAGE,
		memoryBytes: intEnv(env.CODE_RUNNER_MEMORY_MB, 512, 128, 4096) * 1024 * 1024,
		nanoCpus: 1e9,
		pidsLimit: 128,
		defaultTimeoutSec: 60,
		maxTimeoutSec: 120,
		maxConcurrent: intEnv(env.CODE_RUNNER_MAX_CONCURRENT, 3, 1, 16),
		maxInputFiles: 10,
		maxInputBytes: 25 * 1024 * 1024,
		maxOutputFiles: 10,
		maxOutputBytes: 20 * 1024 * 1024,
		maxOutputChars: 20_000,
		dockerHost: env.DOCKER_HOST?.trim() ?? "",
		dockerSocketPath: socket,
	};
}
