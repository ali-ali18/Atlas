const DEFAULT_IMAGE = "atlas-agent-sandbox:latest";
const DEFAULT_VIEWER_HOST = "http://127.0.0.1";

export type SandboxRuntimeConfig = {
	/** Imagem Docker da sandbox (build: docker/agent-sandbox). */
	image: string;
	/** Host público para URLs do noVNC (sem barra final). */
	viewerHost: string;
	/** `direct`: URL `${viewerHost}:${porta}/vnc.html` (porta publicada no host).
	 * `proxy`: URL relativa servida pela API (`/v1/sandbox/sessions/:id/viewer/`),
	 * para quando o browser não alcança as portas da VM (servidor remoto). */
	viewerMode: "direct" | "proxy";
	/** Limite de memória do container (bytes). Padrão: 1 GiB. */
	memoryBytes: number;
	/** CPUs (1.0 = um núcleo). */
	nanoCpus: number;
	/** Rede Docker (`bridge` permite navegação; use `none` para isolar). */
	networkMode: string;
	/** Host usado pela API/worker para falar com o control server da sandbox.
	 * Quando roda em container, use `host.docker.internal`. Padrão: 127.0.0.1. */
	controlHost: string;
	/**
	 * `published` (padrão): portas da VM publicadas em 127.0.0.1 do host e
	 * alcançadas via `controlHost` — funciona no Docker Desktop, NÃO num Linux
	 * com a API em container (127.0.0.1 do host não é alcançável de outro
	 * container). `network`: a VM entra na rede `networkMode` (compartilhada só
	 * com api/worker) e é alcançada pelo IP interno, sem publicar porta.
	 */
	connectMode: "published" | "network";
	/** Habilita TLS (self-signed) no noVNC do container da sessão. Padrão: false. */
	viewerTls: boolean;
	dockerSocketPath: string;
	/** Host TCP do proxy do socket Docker (ex.: tcp://docker-socket-proxy:2375).
	 * Quando setado, o client usa ele em vez do socket direto. Padrão: vazio (socket). */
	dockerHost: string;
	enabled: boolean;
	/** Monta um volume Docker nomeado por conversa no perfil do Chrome
	 * (`/tmp/chrome-data`). Com isso, cookies/logins sobrevivem a stop E a
	 * recriação do container — a VM é do bot e o perfil acompanha a conversa.
	 * Desligue com `SANDBOX_PROFILE_VOLUMES=0` (volta a efêmero). */
	profileVolumes: boolean;
};

function defaultDockerSocketPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const fromEnv = env.DOCKER_SOCKET_PATH?.trim();
	if (fromEnv) return fromEnv;
	// Worker e API no host Windows precisam do named pipe do Docker Desktop.
	if (process.platform === "win32") {
		return "//./pipe/docker_engine";
	}
	return "/var/run/docker.sock";
}

export function loadSandboxConfig(
	env: NodeJS.ProcessEnv = process.env,
): SandboxRuntimeConfig {
	const memoryMb = Number.parseInt(env.SANDBOX_MEMORY_MB ?? "2048", 10);
	const memoryBytes =
		Number.isFinite(memoryMb) && memoryMb > 0
			? memoryMb * 1024 * 1024
			: 2048 * 1024 * 1024;

	const cpus = Number.parseFloat(env.SANDBOX_CPUS ?? "1");
	const nanoCpus =
		Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus * 1e9) : 1e9;

	const enabled =
		env.SANDBOX_ENABLED === undefined
			? true
			: env.SANDBOX_ENABLED === "1" || env.SANDBOX_ENABLED === "true";

	const viewerTls =
		env.SANDBOX_TLS === undefined
			? false
			: env.SANDBOX_TLS === "1" || env.SANDBOX_TLS === "true";

	const profileVolumes =
		env.SANDBOX_PROFILE_VOLUMES === undefined
			? true
			: env.SANDBOX_PROFILE_VOLUMES === "1" ||
				env.SANDBOX_PROFILE_VOLUMES === "true";

	return {
		image: env.SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE,
		viewerHost: (env.SANDBOX_VIEWER_HOST?.trim() || DEFAULT_VIEWER_HOST).replace(
			/\/$/,
			"",
		),
		// Tolerante: `SANDBOX_VIEWER_HOST=proxy` (variável trocada no painel) e o
		// modo `network` (VM sem porta publicada, direto nunca funciona) viram proxy.
		viewerMode:
			env.SANDBOX_VIEWER_MODE?.trim().toLowerCase() === "proxy" ||
			env.SANDBOX_VIEWER_HOST?.trim().toLowerCase() === "proxy" ||
			(env.SANDBOX_VIEWER_MODE?.trim().toLowerCase() !== "direct" &&
				env.SANDBOX_CONNECT_MODE?.trim().toLowerCase() === "network")
				? "proxy"
				: "direct",
		memoryBytes,
		nanoCpus,
		networkMode: env.SANDBOX_NETWORK_MODE?.trim() || "bridge",
		controlHost: env.SANDBOX_CONTROL_HOST?.trim() || "127.0.0.1",
		connectMode: env.SANDBOX_CONNECT_MODE?.trim().toLowerCase() === "network" ? "network" : "published",
		viewerTls,
		dockerSocketPath: defaultDockerSocketPath(env),
		dockerHost: env.DOCKER_HOST?.trim() || "",
		enabled,
		profileVolumes,
	};
}
