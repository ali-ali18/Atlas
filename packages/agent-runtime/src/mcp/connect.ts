import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpToolInfo } from "@workspace/shared";
import { listMcpTools } from "./call.js";
import { McpClientPool } from "./client-pool.js";
import { isMcpAuthFailure } from "./auth-marker.js";
import { sanitizeErrorMessage } from "./sanitize.js";

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

function sensitiveValues(url: string, headers?: Record<string, string>): string[] {
	const values = [url];
	for (const value of Object.values(headers ?? {})) {
		values.push(value);
		const bearer = /^Bearer\s+(.+)$/i.exec(value);
		if (bearer?.[1]) values.push(bearer[1]);
	}
	try {
		const parsed = new URL(url);
		for (const part of parsed.pathname.split("/")) {
			if (part.length >= 4) values.push(part, decodeURIComponent(part));
		}
		for (const value of parsed.searchParams.values()) {
			if (value) values.push(value);
		}
		if (parsed.username) values.push(parsed.username);
		if (parsed.password) values.push(parsed.password);
	} catch {
		// A URL inválida será reportada sem expor o valor original.
	}
	return values.filter(Boolean);
}

function isAuthError(error: unknown): boolean {
	return isMcpAuthFailure(error);
}

/** Conecta, lista as tools e descarta o cliente usado no teste. */
export async function probeMcpServer(input: {
	url: string;
	headers?: Record<string, string>;
	authProvider?: OAuthClientProvider;
	/** Conector `builtin://` (Google): token do cofre em vez de `authProvider`. */
	builtin?: { getAccessToken: () => Promise<string> };
	pool?: McpClientPool;
	timeoutMs?: number;
}): Promise<McpToolInfo[]> {
	const pool = input.pool ?? new McpClientPool();
	const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const secrets = sensitiveValues(input.url, input.headers);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("tempo limite ao conectar ao servidor MCP")), timeoutMs);
		});
		const config = {
			id: `probe-${randomUUID()}`,
			version: "probe",
			name: "MCP probe",
			url: input.url,
			headers: input.headers,
			authProvider: input.authProvider,
			builtin: input.builtin,
		};
		return await Promise.race([
			pool.withClient(config, listMcpTools),
			timeout,
		]);
	} catch (error) {
		if (isAuthError(error)) throw new Error("credencial recusada pelo servidor");
		throw new Error(sanitizeErrorMessage(error, secrets));
	} finally {
		if (timer) clearTimeout(timer);
		// Uma conexão travada não pode reter a resposta após o timeout do probe.
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pool.closeAll().catch(() => undefined),
				new Promise<void>((resolve) => {
					closeTimer = setTimeout(resolve, 1_000);
				}),
			]);
		} finally {
			if (closeTimer) clearTimeout(closeTimer);
		}
	}
}
