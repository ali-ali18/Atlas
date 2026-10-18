import { randomBytes } from "node:crypto";
import type Docker from "dockerode";
import { shouldRecreateForImage } from "../image-staleness.js";
import type { DevSandboxConfig } from "./config.js";

/**
 * Saída de internet aplicada na REDE (sem NET_ADMIN nos containers de sessão):
 *  - containers com política `allowlist`/`off` ficam SÓ numa rede Docker `internal`
 *    (sem rota para a internet);
 *  - um container "gateway" (proxy HTTP/CONNECT, mesma imagem) fica nessa rede e na
 *    rede normal e aplica a política de cada sessão, identificada pelo IP de origem;
 *  - o gerenciador registra IP -> política no endpoint de controle do gateway.
 */

export type EgressPolicy = { mode: "full" | "allowlist" | "off"; allowlist: string[] };

export const GATEWAY_LABEL = "atlas.dev-egress";
export const GATEWAY_PROXY_PORT = 3128;
export const GATEWAY_CONTROL_PORT = 3129;
const TOKEN_ENV = "EGRESS_CONTROL_TOKEN";

type EgressConfig = Pick<DevSandboxConfig, "egressEnforce" | "egressMode" | "egressAllowlist" | "internalNetwork" | "networkMode" | "gatewayName">;

/** Política efetiva: a do ambiente, ou a do servidor para sessões sem ambiente. */
export function effectivePolicy(config: Pick<DevSandboxConfig, "egressMode" | "egressAllowlist">, egress?: EgressPolicy): EgressPolicy {
	return egress ?? { mode: config.egressMode === "allowlist" ? "allowlist" : "full", allowlist: config.egressAllowlist };
}

/** O container desta política deve ficar só na rede interna? */
export function wantsInternalNetwork(config: EgressConfig, egress?: EgressPolicy): boolean {
	return config.egressEnforce && effectivePolicy(config, egress).mode !== "full";
}

/** Rede primária do container conforme a política. */
export function networkForPolicy(config: EgressConfig, egress?: EgressPolicy): string {
	return wantsInternalNetwork(config, egress) ? config.internalNetwork : config.networkMode;
}

/** Proxy que o container usa (nome DNS do gateway na rede interna). */
export function gatewayProxyUrl(config: Pick<DevSandboxConfig, "gatewayName">): string {
	return `http://${config.gatewayName}:${GATEWAY_PROXY_PORT}`;
}

type NetInspect = { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string } | undefined> } };

/** IP do container na rede dada. */
export function ipOnNetwork(inspect: NetInspect, network: string): string | undefined {
	return inspect.NetworkSettings?.Networks?.[network]?.IPAddress?.trim() || undefined;
}

function statusOf(error: unknown): number | undefined {
	return (error as { statusCode?: number }).statusCode;
}

export type EgressGateway = {
	/** Garante rede interna + gateway rodando; `fresh` = o gateway acabou de (re)subir (registros perdidos). */
	ensure(): Promise<{ fresh: boolean }>;
	register(ip: string, policy: EgressPolicy, sessionId?: string): Promise<void>;
	unregister(ip: string): Promise<void>;
};

export type EgressGatewayOptions = {
	docker: () => Docker;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
};

export function createEgressGateway(config: DevSandboxConfig, options: EgressGatewayOptions): EgressGateway {
	const doFetch = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let control: { url: string; token: string } | null = null;
	let chain: Promise<unknown> = Promise.resolve();
	const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = chain.then(fn, fn);
		chain = run.catch(() => undefined);
		return run;
	};

	async function ensureNetwork(): Promise<void> {
		const docker = options.docker();
		try {
			const info = await docker.getNetwork(config.internalNetwork).inspect();
			// Rede existente que NÃO é interna daria internet a quem deveria estar isolado: falha fechada.
			if (!info.Internal) throw new Error(`A rede "${config.internalNetwork}" existe mas não é internal; recrie-a com internal: true`);
			return;
		} catch (error) {
			if (statusOf(error) !== 404) throw error;
		}
		try {
			await docker.createNetwork({
				Name: config.internalNetwork,
				Driver: "bridge",
				Internal: true,
				CheckDuplicate: true,
				Labels: { [GATEWAY_LABEL]: "network" },
			});
		} catch (error) {
			if (statusOf(error) !== 409) throw error;
		}
	}

	async function inspectGateway() {
		try {
			return await options.docker().getContainer(config.gatewayName).inspect();
		} catch (error) {
			if (statusOf(error) === 404) return null;
			throw error;
		}
	}

	async function ensureGatewayContainer(): Promise<{ fresh: boolean }> {
		const docker = options.docker();
		let inspect = await inspectGateway();
		let fresh = false;
		if (inspect) {
			let stale = false;
			try {
				stale = shouldRecreateForImage(inspect.Image, (await docker.getImage(config.gatewayImage).inspect()).Id);
			} catch {
				stale = false;
			}
			if (stale) {
				await docker.getContainer(inspect.Id).remove({ force: true });
				inspect = null;
			}
		}
		if (!inspect) {
			const memory = config.gatewayMemoryMb * 1024 * 1024;
			const container = await docker.createContainer({
				Image: config.gatewayImage,
				name: config.gatewayName,
				Cmd: ["node", "/app/egress-gateway.mjs"],
				Env: [`${TOKEN_ENV}=${randomBytes(24).toString("hex")}`],
				Labels: { [GATEWAY_LABEL]: "gateway" },
				Healthcheck: {
					Test: ["CMD", "node", "-e", `fetch('http://127.0.0.1:${GATEWAY_CONTROL_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
					Interval: 30_000_000_000,
					Timeout: 3_000_000_000,
					Retries: 3,
				},
				HostConfig: {
					// Rede primária = a normal (com internet); a interna entra como segunda rede.
					NetworkMode: config.networkMode,
					Memory: memory,
					MemorySwap: memory,
					NanoCpus: 500_000_000,
					PidsLimit: 128,
					Init: true,
					CapDrop: ["ALL"],
					SecurityOpt: ["no-new-privileges"],
					ReadonlyRootfs: true,
					RestartPolicy: { Name: "unless-stopped" },
				},
			});
			await docker.getNetwork(config.internalNetwork).connect({ Container: container.id, EndpointConfig: { Aliases: [config.gatewayName] } });
			await container.start();
			fresh = true;
			inspect = await container.inspect();
		} else if (!inspect.State?.Running) {
			await docker.getContainer(inspect.Id).start();
			fresh = true;
			inspect = await docker.getContainer(inspect.Id).inspect();
		} else if (!inspect.NetworkSettings?.Networks?.[config.internalNetwork]) {
			await docker.getNetwork(config.internalNetwork).connect({ Container: inspect.Id, EndpointConfig: { Aliases: [config.gatewayName] } });
			inspect = await docker.getContainer(inspect.Id).inspect();
		}
		const token = inspect.Config?.Env?.find((item) => item.startsWith(`${TOKEN_ENV}=`))?.slice(TOKEN_ENV.length + 1);
		const ip = ipOnNetwork(inspect, config.internalNetwork);
		if (!token || !ip) throw new Error("Gateway de saída sem token ou sem IP na rede interna");
		control = { url: `http://${ip}:${GATEWAY_CONTROL_PORT}`, token };
		return { fresh };
	}

	async function waitHealthy(): Promise<void> {
		const attempts = options.attempts ?? 20;
		for (let i = 0; i < attempts; i += 1) {
			try {
				const res = await doFetch(`${control!.url}/health`, { signal: AbortSignal.timeout(2_000) });
				if (res.ok) return;
			} catch {
				// ainda subindo
			}
			await sleep(500);
		}
		throw new Error(
			`Gateway de saída não respondeu em ${control?.url}. O worker/API precisam estar na rede "${config.internalNetwork}" (ver docker/dev-sandbox/README.md)`,
		);
	}

	async function call(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<void> {
		if (!control) throw new Error("Gateway de saída não inicializado");
		const res = await doFetch(`${control.url}${path}`, {
			method,
			headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) throw new Error(`Gateway de saída respondeu ${res.status}`);
	}

	return {
		ensure() {
			return serialized(async () => {
				await ensureNetwork();
				const result = await ensureGatewayContainer();
				await waitHealthy();
				return result;
			});
		},
		async register(ip, policy, sessionId) {
			await call("PUT", `/sessions/${encodeURIComponent(ip)}`, { mode: policy.mode, allowlist: policy.allowlist, sessionId });
		},
		async unregister(ip) {
			await call("DELETE", `/sessions/${encodeURIComponent(ip)}`);
		},
	};
}
