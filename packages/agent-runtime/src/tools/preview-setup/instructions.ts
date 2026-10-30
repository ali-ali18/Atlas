import type { DnsProviderId, PreviewSetupState, SetupStepId } from "@workspace/shared";
import { manualDnsInstructions } from "./dns.js";

/**
 * Passos que o Atlas NÃO escreve sozinho (certificado, rota, variável, reinício): instruções exatas para o dono
 * fazer no painel/proxy. O texto vai ao modelo (inglês) para ele repassar em palavras simples, no idioma do usuário.
 * Os nomes de variáveis dos provedores no proxy seguem o lego (ACME do Traefik/Caddy); conferir no painel real.
 */

const LEGO_ENV: Record<Exclude<DnsProviderId, "manual">, { provider: string; env: string }> = {
	cloudflare: { provider: "cloudflare", env: "CF_DNS_API_TOKEN" },
	desec: { provider: "desec", env: "DESEC_TOKEN" },
};

export function tlsInstructions(state: PreviewSetupState): string {
	if (state.tls === "origin-cert") {
		return [
			"Certificate (Cloudflare origin certificate, proxy ON):",
			`1. Cloudflare dashboard > the zone ${state.domain} > SSL/TLS > Origin Server > Create Certificate, hostnames "*.${state.domain}" and "${state.domain}".`,
			state.platform === "dokploy" ? "2. Paste the certificate and the private key in Dokploy > Settings > Certificates (confirm the exact menu in the panel)." : "2. Install the certificate and the key in the proxy for those hostnames.",
			"3. Cloudflare > SSL/TLS > Overview: set the mode to Full (strict) for this zone.",
			"The user must do this in the Cloudflare/Dokploy screens. Warn them NEVER to paste the certificate or key in the chat.",
		].join("\n");
	}
	const lego = state.dnsProvider === "manual" ? null : LEGO_ENV[state.dnsProvider];
	return [
		"Certificate (wildcard by DNS challenge, issued by the proxy itself):",
		`1. In the proxy (Traefik in Dokploy), add an ACME certificate resolver using the DNS challenge for "*.${state.domain}"${lego ? ` with provider "${lego.provider}"` : " with the provider that hosts the DNS"}.`,
		lego ? `2. Put the DNS token in the PROXY's own environment (Traefik service environment), variable ${lego.env}. The token stays in the proxy; it is not given to the Atlas.` : "2. Put that provider's DNS token in the proxy's own environment (see the provider list of the ACME client, lego).",
		"3. Restart the proxy so it requests the certificate (takes a minute or two).",
		"The user must do this in the proxy/Dokploy screens. Warn them never to paste the token in the chat.",
	].join("\n");
}

export function routeInstructions(state: PreviewSetupState): string {
	const resolver = state.tls === "dns01-proxy" ? "tls.certresolver=<resolver name>" : "tls=true (with the origin certificate installed)";
	const labels = [
		`traefik.http.routers.atlas-preview.rule=HostRegexp(\`^[a-z0-9]+\\.${state.domain.replace(/\./g, "\\.")}$\`)`,
		"traefik.http.routers.atlas-preview.entrypoints=websecure",
		`traefik.http.routers.atlas-preview.${resolver}`,
		"traefik.http.services.atlas-preview.loadbalancer.server.port=3001",
	];
	if (state.platform === "dokploy") {
		return [
			"Route to the Atlas API:",
			`1. Dokploy > the compose/service that runs the "api" > Domains > add host "*.${state.domain}", port 3001, HTTPS on, NO path (certificate: ${state.tls === "origin-cert" ? "the origin certificate" : "the DNS-challenge resolver"}).`,
			"2. If the panel refuses a wildcard host, add these labels to the api service instead and attach it to the proxy network:",
			...labels.map((l) => `   ${l}`),
			"(confirm in the real panel; this cannot be done by the Atlas)",
		].join("\n");
	}
	return [
		"Route to the Atlas API (generic proxy):",
		"Traefik labels on the api service (and its network shared with Traefik):",
		...labels.map((l) => `   ${l}`),
		`Caddy alternative: a site block for "*.${state.domain}" with the wildcard certificate and "reverse_proxy api:3001".`,
	].join("\n");
}

export function envInstructions(state: PreviewSetupState): string {
	return [
		`Set the environment variable ATLAS_PREVIEW_BASE_DOMAIN=${state.domain} (no https://, no wildcard) for BOTH the "api" and the "worker" services${state.platform === "dokploy" ? " (Dokploy > Environment; the compose already passes it to both)" : ""}.`,
		"Also make sure DEV_SANDBOX_CONNECT_MODE=network (default).",
	].join("\n");
}

export function redeployInstructions(state: PreviewSetupState): string {
	return `Redeploy the stack${state.platform === "dokploy" ? " in Dokploy (Deploy button)" : ""} so the api and the worker restart with the new variable. The chat connection will drop for a minute: that is expected. When the user is back, call preview_setup again with action "status" to continue.`;
}

export function dnsManualInstructions(state: PreviewSetupState): string {
	return manualDnsInstructions(state.domain, state.serverIp, state.tls === "origin-cert" && state.dnsProvider === "cloudflare");
}

export function stepInstructions(step: SetupStepId, state: PreviewSetupState): string {
	switch (step) {
		case "dns": return dnsManualInstructions(state);
		case "tls": return tlsInstructions(state);
		case "route": return routeInstructions(state);
		case "env": return envInstructions(state);
		case "redeploy": return redeployInstructions(state);
		default: return "";
	}
}

/** Como criar o token do DNS (para o cartão seguro e para o texto ao usuário). */
export function dnsTokenHelp(provider: Exclude<DnsProviderId, "manual">, domain: string): string {
	return provider === "cloudflare"
		? `Cloudflare > My Profile > API Tokens > Create Token (custom): permissions Zone:Zone:Read and Zone:DNS:Edit, only for the zone of ${domain}.`
		: "deSEC > Token Management > create a token (the default token can edit DNS of your domains).";
}
