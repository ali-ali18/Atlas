import { createHash } from "node:crypto";
import {
	SETUP_SECRET_DNS_TOKEN, SETUP_STEP_LABEL, createSetupState, isDnsProvider, isSetupComplete, isSetupPlatform, isTlsStrategy, nextSetupStep,
	normalizeServerIp, previewProbeHost, quoteUntrusted, rollbackTargets, validateSetupDomain, withStep, type PreviewSetupState, type SetupStepId,
} from "@workspace/shared";
import { sanitizeErrorMessage } from "../../mcp/sanitize.js";
import type { Checks } from "./checks.js";
import { DnsProviderError, type DnsProvider, type DnsZone } from "./dns.js";
import { dnsTokenHelp, stepInstructions } from "./instructions.js";

/**
 * Máquina de passos da prévia completa: dns → tls → rota → variável → reinício → teste.
 * Cada chamada de `runSetup` avança no máximo UM passo, grava o estado antes de responder (retoma depois do
 * reinício do servidor) e só escreve em sistema externo depois da aprovação do dono no cartão. Só o DNS é
 * escrito pelo Atlas (e desfeito por id); o resto é guiado e verificado.
 */

export type SetupResult = { summary: string; confirmEvent?: unknown };

export type SetupDeps = {
	userId: string;
	atlasUrl: string;
	/** Outros endereços do Atlas (web, login) que também precisam ser de outro site que o domínio da prévia. */
	webUrls?: Array<string | undefined>;
	now: () => Date;
	loadState: () => Promise<PreviewSetupState | null>;
	saveState: (state: PreviewSetupState) => Promise<void>;
	deleteState: () => Promise<void>;
	/** O estado gravado existe mas não pôde ser lido (corrompido)? */
	stateIsCorrupt?: () => Promise<boolean>;
	/** Já há um cartão de aprovação desta chamada esperando resposta? (evita cartão repetido) */
	isApprovalPending?: (callKey: string) => Promise<boolean>;
	/** Token do DNS no cofre do dono (`null` = falta). Nunca sai deste módulo. */
	getDnsToken: () => Promise<string | null>;
	providerFor: (id: "cloudflare" | "desec", token: string) => DnsProvider;
	checks: Checks;
	/** O dono já aprovou esta chamada (mesma chave) neste chat? */
	findApproved: (callKey: string) => Promise<boolean>;
	requestApproval: (input: { callKey: string; title: string; description: string }) => Promise<unknown>;
	/** O servidor atual (este processo) já enxerga a variável do domínio? */
	envApplied: (domain: string) => boolean;
	sleep: (ms: number) => Promise<void>;
};

export type SetupArgs = {
	action: "status" | "configure" | "run" | "rollback";
	domain?: unknown;
	dns_provider?: unknown;
	tls?: unknown;
	platform?: unknown;
	server_ip?: unknown;
	user_confirms?: unknown;
	/** configure: descarta um estado corrompido que o Atlas não consegue ler. */
	reset?: unknown;
};

const key = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export function renderStatus(state: PreviewSetupState): string {
	const lines = Object.entries(state.steps).map(([id, s]) => `- ${SETUP_STEP_LABEL[id as SetupStepId]}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`);
	return [`Preview setup for ${state.domain} (DNS: ${state.dnsProvider}, certificate: ${state.tls}, platform: ${state.platform}, server IP ${state.serverIp}):`, ...lines].join("\n");
}

function nextHint(state: PreviewSetupState): string {
	const step = nextSetupStep(state);
	return step ? `Next step: ${SETUP_STEP_LABEL[step]}. Call preview_setup with action "run".` : "All steps are done.";
}

async function persist(deps: SetupDeps, state: PreviewSetupState, step: SetupStepId, patch: Parameters<typeof withStep>[2]): Promise<PreviewSetupState> {
	const next = withStep(state, step, patch, deps.now());
	await deps.saveState(next);
	return next;
}

const READY = "Prévia completa ligada";

/** Proxy da Cloudflare ligado: o nome resolve para a Cloudflare, não para o IP do servidor. */
const expectedIp = (state: PreviewSetupState): string | null => (state.tls === "origin-cert" && state.dnsProvider === "cloudflare" ? null : state.serverIp);

export async function runSetup(deps: SetupDeps, args: SetupArgs): Promise<SetupResult> {
	switch (args.action) {
		case "status": return status(deps);
		case "configure": return configure(deps, args);
		case "run": return run(deps, args);
		case "rollback": return rollback(deps);
		default: throw new Error('action must be "status", "configure", "run" or "rollback".');
	}
}

async function status(deps: SetupDeps): Promise<SetupResult> {
	const state = await deps.loadState();
	if (!state) return { summary: 'No preview setup yet. Ask the user for the preview domain (a separate domain, not the Atlas one; a free name like <name>.dedyn.io works), the server public IPv4, where the DNS is hosted ("cloudflare", "desec" or "manual") and the platform ("dokploy" or "generic"), then call preview_setup with action "configure".' };
	return { summary: `${renderStatus(state)}\n${isSetupComplete(state) ? `Complete. Tell the user: ${READY}.` : nextHint(state)}` };
}

async function configure(deps: SetupDeps, args: SetupArgs): Promise<SetupResult> {
	if (!(await deps.loadState()) && (await deps.stateIsCorrupt?.()) && args.reset !== true) {
		throw new Error('A previous setup is saved but cannot be read (corrupted). Nothing was changed. Tell the user that something may already exist from before: a wildcard DNS record "*.<preview domain>" at their DNS host, a certificate, a route, or the ATLAS_PREVIEW_BASE_DOMAIN variable. Ask if they want to start over; only then call configure again with reset true (existing items are NOT removed automatically).');
	}
	const domain = validateSetupDomain(args.domain, [deps.atlasUrl, ...(deps.webUrls ?? [])]);
	if ("error" in domain) throw new Error(domain.error);
	if (!isDnsProvider(args.dns_provider)) throw new Error('dns_provider must be "cloudflare", "desec" or "manual". Ask where the DNS of the domain is hosted.');
	const tls = isTlsStrategy(args.tls) ? args.tls : args.dns_provider === "cloudflare" && domain.domain.split(".").length === 2 ? "origin-cert" : "dns01-proxy";
	const platform = isSetupPlatform(args.platform) ? args.platform : "generic";
	const serverIp = normalizeServerIp(args.server_ip);
	if (!serverIp) throw new Error("server_ip must be the public IPv4 of the server in plain form like 203.0.113.7 (no leading zeros; not a private, loopback or reserved address).");
	if (tls === "origin-cert" && args.dns_provider !== "cloudflare") throw new Error('tls "origin-cert" only works with DNS on Cloudflare; use "dns01-proxy".');
	const existing = await deps.loadState();
	if (existing && rollbackTargets(existing)) throw new Error('A setup with DNS records created by the Atlas already exists. Call action "rollback" first or continue it with "run".');
	// A sequência começa no relógio (segundos): um setup novo, mesmo depois de desfazer, nunca reaproveita a aprovação de um anterior.
	const state = { ...createSetupState({ domain: domain.domain, dnsProvider: args.dns_provider, tls, platform, serverIp }), approvalSeq: Math.floor(deps.now().getTime() / 1000) };
	await deps.saveState(state);
	const needsToken = args.dns_provider !== "manual";
	return {
		summary: [
			`Setup saved for ${state.domain}. ${renderStatus(state)}`,
			needsToken ? `The DNS token is needed: call secret_request with names ["${SETUP_SECRET_DNS_TOKEN}"] and a short reason; the user pastes it in the secure card (you never see it). How to make it: ${dnsTokenHelp(args.dns_provider as "cloudflare" | "desec", state.domain)}` : "DNS is manual: you will give the user the exact record to create.",
			'Then call preview_setup with action "run". Every step that writes anywhere asks the user for approval in a card first.',
		].join("\n"),
	};
}

async function run(deps: SetupDeps, args: SetupArgs): Promise<SetupResult> {
	const state = await deps.loadState();
	if (!state) throw new Error('No preview setup yet. Call preview_setup with action "configure" first.');
	const step = nextSetupStep(state);
	if (!step) return { summary: `All steps are already done. Tell the user: ${READY}.` };
	switch (step) {
		case "dns": return dnsStep(deps, state);
		case "tls":
		case "route": return guidedStep(deps, state, step);
		case "env":
		case "redeploy": return confirmedStep(deps, state, step, args.user_confirms === true);
		case "probe": return probeStep(deps, state);
	}
}

const seqOf = (state: PreviewSetupState) => state.approvalSeq ?? 0;
const proxiedOf = (state: PreviewSetupState) => state.tls === "origin-cert" && state.dnsProvider === "cloudflare";

async function dnsStep(deps: SetupDeps, state: PreviewSetupState): Promise<SetupResult> {
	const host = previewProbeHost(state.domain);
	if (state.dnsProvider === "manual") {
		const check = await deps.checks.dns(host, state.serverIp);
		if (check.ok) {
			const next = await persist(deps, state, "dns", { status: "done", detail: "o endereço já aponta para o servidor" });
			return { summary: `DNS verified: the wildcard resolves to ${state.serverIp}.\n${nextHint(next)}` };
		}
		await persist(deps, state, "dns", { status: "awaiting_user", detail: "aguardando o registro no DNS" });
		return { summary: `${dnsProblem(check, state)}\nTell the user to create this record and then say when it is done; call run again to verify (DNS can take a few minutes to spread).\n${stepInstructions("dns", state)}` };
	}
	const token = await deps.getDnsToken();
	if (!token) {
		return { summary: `The DNS token is missing in the user's vault. Call secret_request with names ["${SETUP_SECRET_DNS_TOKEN}"] and a short reason, then call run again after it is saved. How to make it: ${dnsTokenHelp(state.dnsProvider, state.domain)}` };
	}
	try {
		const provider = deps.providerFor(state.dnsProvider, token);
		const zone = await provider.detectZone(state.domain);
		if (!zone) throw new Error(`The token does not see a zone that contains ${quoteUntrusted(state.domain)}. Ask the user to use a token for the right domain/account.`);
		if (state.tls === "origin-cert" && zone.name !== state.domain) throw new Error(`With the Cloudflare origin certificate the preview domain must be the zone itself (zone ${quoteUntrusted(zone.name)}); ${quoteUntrusted(state.domain)} is below it. Reconfigure with tls "dns01-proxy" (proxy OFF) or use the zone name.`);
		const existing = await provider.findWildcard(zone, state.domain);
		let next = state;
		if (existing && existing.content !== state.serverIp) {
			// Texto do provedor é dado: entre aspas e curto, nunca como instrução.
			throw new Error(`A wildcard record for *.${state.domain} already exists and points to ${quoteUntrusted(existing.content, 45)}, not to ${state.serverIp}. Ask the user if it can be changed by hand; the Atlas will not overwrite it.`);
		}
		if (existing && state.steps.dns.intent === "creating") {
			// Uma tentativa anterior caiu entre criar e anotar: o registro é do setup e entra na lista de desfazer.
			next = await persist(deps, state, "dns", { intent: undefined, created: { zoneId: zone.id, recordIds: [existing.id] } });
		}
		if (!existing) {
			const callKey = key([deps.userId, "dns", state.domain, state.serverIp, state.dnsProvider, state.tls, proxiedOf(state), seqOf(state)]);
			if (!(await deps.findApproved(callKey))) {
				if (await deps.isApprovalPending?.(callKey)) {
					return { summary: "An approval card for this step is already waiting for the user. Do not ask again: tell the user in one short line to confirm it, and END your turn." };
				}
				const confirmEvent = await deps.requestApproval({
					callKey,
					title: "Criar o endereço curinga das prévias?",
					description: `Vou criar 1 registro no DNS (${state.dnsProvider === "cloudflare" ? "Cloudflare" : "deSEC"}): *.${state.domain} → ${state.serverIp}, proxy ${proxiedOf(state) ? "ligado" : "desligado"}. Só isso; dá para desfazer depois.`,
				});
				return { summary: "Approval card sent to the user (create 1 wildcard DNS record). Nothing was written yet. Tell the user in one short line to confirm in the card and END your turn; after they confirm you are called again: call run again.", confirmEvent };
			}
			// Intenção antes da escrita: se o processo cair depois de criar, a retomada reconhece o registro como nosso.
			next = await persist(deps, next, "dns", { status: "pending", detail: "criando o registro", intent: "creating", created: { zoneId: zone.id, recordIds: [] } });
			const created = await provider.createWildcard(zone, state.domain, state.serverIp, { proxied: proxiedOf(state) });
			// A aprovação vale uma vez só: a sequência sobe, e desfazer e refazer pede cartão novo.
			next = { ...next, approvalSeq: seqOf(next) + 1 };
			next = await persist(deps, next, "dns", { status: "pending", detail: "registro criado; aguardando propagar", intent: undefined, created: { zoneId: zoneRef(zone), recordIds: [created.id] } });
		}
		return await verifyDnsAfterWrite(deps, next, host);
	} catch (error) {
		return failStep(deps, state, "dns", error, token);
	}
}

const zoneRef = (zone: DnsZone) => zone.id;

async function verifyDnsAfterWrite(deps: SetupDeps, state: PreviewSetupState, host: string): Promise<SetupResult> {
	let last = await deps.checks.dns(host, expectedIp(state));
	for (let i = 0; i < 3 && !last.ok; i++) {
		await deps.sleep(2_000);
		last = await deps.checks.dns(host, expectedIp(state));
	}
	if (!last.ok) {
		await persist(deps, state, "dns", { status: "pending", detail: "criado; ainda propagando" });
		return { summary: `The DNS record exists but is not visible yet (${dnsProblem(last, state)}). This is normal for a few minutes. Tell the user to wait and call run again shortly.` };
	}
	// Com o proxy da Cloudflare ligado o IP que resolve é da Cloudflare, não o do servidor: o ok vem da checagem por IP só no modo sem proxy.
	const next = await persist(deps, state, "dns", { status: "done", detail: "endereço curinga ativo" });
	return { summary: `DNS verified: *.${state.domain} resolves to the server.\n${nextHint(next)}` };
}

function dnsProblem(check: { reason?: string; found: string[] }, state: PreviewSetupState): string {
	if (check.reason === "wrong_ip") return `The name resolves to ${check.found.join(", ")} instead of ${state.serverIp}.`;
	if (check.reason === "no_record") return "The wildcard name does not resolve yet.";
	return "Could not check DNS right now.";
}

async function failStep(deps: SetupDeps, state: PreviewSetupState, step: SetupStepId, error: unknown, token?: string): Promise<SetupResult> {
	const message = error instanceof DnsProviderError || error instanceof Error ? sanitizeErrorMessage(error, token ? [token] : [], 400) : "erro desconhecido";
	// Estado mais novo do banco: a intenção "creating" e os ids criados gravados no meio do passo não podem ser perdidos.
	const latest = (await deps.loadState().catch(() => null)) ?? state;
	await persist(deps, latest, step, { status: "failed", detail: message.slice(0, 200) });
	throw new Error(`${message} (the step can be retried with run after fixing it)`);
}

/** TLS e rota: o Atlas não escreve; dá as instruções, depois verifica de verdade. */
async function guidedStep(deps: SetupDeps, state: PreviewSetupState, step: "tls" | "route"): Promise<SetupResult> {
	const host = previewProbeHost(state.domain);
	if (state.steps[step].status === "awaiting_user") {
		if (step === "tls") {
			const check = await deps.checks.tls(host, state.domain);
			if (check.ok) {
				const next = await persist(deps, state, "tls", { status: "done", detail: `certificado válido (${check.issuer ?? "emissor desconhecido"})` });
				return { summary: `Certificate verified: valid wildcard for *.${state.domain}.\n${nextHint(next)}` };
			}
			return { summary: `Certificate not ready: ${tlsProblem(check.reason)}. Tell the user what is missing and call run again when fixed.\n${stepInstructions("tls", state)}` };
		}
		const probe = await deps.checks.probe(state.domain);
		if (probe.kind !== "ok" && probe.kind !== "not_enabled") {
			return { summary: `The route is not reaching the Atlas yet. ${probeHint(probe.kind, probe.status)}\n${stepInstructions("route", state)}` };
		}
		// `not_enabled` aqui é esperado: a rota chega na API do Atlas, só falta a variável (próximos passos).
		const next = await persist(deps, state, "route", { status: "done", detail: "a rota chega até o Atlas" });
		return { summary: `Route verified: the address reaches the Atlas.\n${nextHint(next)}` };
	}
	await persist(deps, state, step, { status: "awaiting_user", detail: "aguardando você fazer no painel" });
	return { summary: `The user has to do this in their server screens (the Atlas cannot). Explain it in plain words, step by step, then wait for them to say it is done and call run to verify.\n${stepInstructions(step, state)}` };
}

/** Dica para o administrador a partir do que a sonda viu (texto ao modelo; ele repassa em palavras simples). */
function probeHint(kind: string, status?: number): string {
	switch (kind) {
		case "origin_cert": return "Cloudflare answered 526: it does not accept the certificate of the origin server. Check the origin certificate installed in the proxy for this domain and that the Cloudflare SSL mode matches (Full strict needs the origin certificate).";
		case "origin_unreachable": return `Cloudflare answered ${status ?? "52x"}: it cannot reach the server. Check that the proxy listens on 443, the firewall allows it, and the DNS record points to the right server IP.`;
		case "tls_error": return "HTTPS fails at that address (certificate problem).";
		case "unreachable": return "Nothing answers at that address yet.";
		default: return `Something other than the Atlas answered (HTTP ${status ?? "?"}), usually the proxy without a route for this host. Check that the host "*.<domain>" is routed to the api service on port 3001.`;
	}
}

function tlsProblem(reason?: string): string {
	return ({ unreachable: "nothing answers on HTTPS at that name yet", untrusted: "the certificate is not trusted", expired: "the certificate expired", san_mismatch: "the certificate does not cover the wildcard name" } as Record<string, string>)[reason ?? ""] ?? "unknown problem";
}

/** Variável e reinício não têm verificação própria: o aval é do usuário; o teste final é quem prova. */
async function confirmedStep(deps: SetupDeps, state: PreviewSetupState, step: "env" | "redeploy", userConfirms: boolean): Promise<SetupResult> {
	if (state.steps[step].status === "awaiting_user" && userConfirms) {
		const next = await persist(deps, state, step, { status: "done", detail: "confirmado por você" });
		return { summary: `Noted.\n${nextHint(next)}` };
	}
	await persist(deps, state, step, { status: "awaiting_user", detail: "aguardando você fazer no painel" });
	return { summary: `The user has to do this in their server screens (the Atlas cannot). Explain it in plain words, then call run with user_confirms true only after the USER says it is done.\n${stepInstructions(step, state)}` };
}

async function probeStep(deps: SetupDeps, state: PreviewSetupState): Promise<SetupResult> {
	const probe = await deps.checks.probe(state.domain);
	const reopen = async (detail: string, steps: Array<"tls" | "route" | "env" | "redeploy">) => {
		let next = state;
		for (const s of steps) next = withStep(next, s, { status: "awaiting_user", detail }, deps.now());
		await deps.saveState(next);
		return next;
	};
	if (probe.kind === "ok") {
		if (!deps.envApplied(state.domain)) {
			await reopen("o servidor ainda não reiniciou com o domínio", ["redeploy"]);
			return { summary: "The address answers, but the task server (worker) still runs without the preview domain variable. Tell the user the worker needs the variable too and a redeploy; then call run again." };
		}
		const next = await persist(deps, state, "probe", { status: "done", detail: "teste final passou" });
		return { summary: `Final check passed: HTTPS works and the API answers on the preview address.\n${isSetupComplete(next) ? `Tell the user: ${READY}. They can now ask for a web project and get the live link.` : nextHint(next)}` };
	}
	// Só "a API do Atlas respondeu sem a prévia" aponta para variável/reinício; o resto é rota ou certificado e não mexe neles.
	if (probe.kind === "not_enabled") {
		await reopen("a API ainda não tem o domínio configurado", ["env", "redeploy"]);
		return { summary: "The address reaches the Atlas but the preview is not enabled there: the variable is missing or the services were not restarted. Tell the user to check ATLAS_PREVIEW_BASE_DOMAIN on api and worker and redeploy, then call run again." };
	}
	if (probe.kind === "unreachable") return { summary: "Nothing answers on the preview address yet. If a redeploy just happened wait a minute and call run again; otherwise check the route and DNS (status shows each step)." };
	const step = probe.kind === "origin_cert" || probe.kind === "tls_error" ? "tls" : "route";
	await reopen(step === "tls" ? "o certificado não foi aceito" : "a rota não chega no Atlas", [step]);
	return { summary: `The final check failed. ${probeHint(probe.kind, probe.status)} The ${step === "tls" ? "certificate" : "route"} step was reopened; fix it and call run again. The variable and restart steps stay as they are.` };
}

async function rollback(deps: SetupDeps): Promise<SetupResult> {
	const state = await deps.loadState();
	if (!state) return { summary: "There is no setup to undo." };
	const targets = rollbackTargets(state);
	if (!targets) {
		await deps.deleteState();
		return { summary: "Setup cleared. The Atlas had created nothing outside itself, so there is nothing to remove (anything done by hand in the panels stays)." };
	}
	const token = await deps.getDnsToken();
	if (!token || state.dnsProvider === "manual") return { summary: `The DNS token is missing in the vault; ask for it (secret_request ["${SETUP_SECRET_DNS_TOKEN}"]) to remove the record the Atlas created, or tell the user to delete the wildcard record by hand.` };
	const callKey = key([deps.userId, "rollback", state.domain, targets.recordIds, seqOf(state)]);
	if (!(await deps.findApproved(callKey))) {
		if (await deps.isApprovalPending?.(callKey)) return { summary: "An approval card for this step is already waiting for the user. Do not ask again: tell the user in one short line to confirm it, and END your turn." };
		const confirmEvent = await deps.requestApproval({ callKey, title: "Desfazer o endereço curinga?", description: `Vou apagar do DNS só o registro que eu criei para *.${state.domain}. O resto da configuração fica como está.` });
		return { summary: "Approval card sent (remove the DNS record the Atlas created). Nothing was removed yet; END your turn and call rollback again after the user confirms.", confirmEvent };
	}
	let removed = 0;
	try {
		const provider = deps.providerFor(state.dnsProvider, token);
		for (const id of targets.recordIds) {
			if ((await provider.deleteRecord({ id: targets.zoneId, name: state.domain }, id, state.serverIp)) === "removed") removed++;
		}
	} catch (error) {
		return failStep(deps, state, "dns", error, token);
	}
	await deps.deleteState();
	return {
		summary: removed > 0
			? "The DNS record created by the Atlas was removed and the setup was cleared."
			: "The DNS record was not found at the provider (it no longer existed, or someone already removed it), so nothing was deleted. The setup was cleared. Tell the user plainly that nothing was removed.",
	};
}
