import { describe, expect, it } from "vitest";
import { SETUP_STEPS, createSetupState, nextSetupStep, withStep, type PreviewSetupState } from "@workspace/shared";
import { checkDns, checkTlsFromCert, probeApi, sanCovers } from "./checks.js";
import { cloudflareProvider, desecProvider, DnsProviderError, type FetchFn } from "./dns.js";
import { runSetup, type SetupDeps } from "./machine.js";
import { executePreviewSetup } from "./tool.js";

const TOKEN = "tok_SECRET_123456";
const DOMAIN = "previas.exemplo.com";
const IP = "203.0.113.7";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(routes: Array<{ match: (c: Call) => boolean; status: number; body?: unknown }>) {
	const calls: Call[] = [];
	const fn: FetchFn = async (url, init) => {
		const call = { url, method: init.method, headers: init.headers, body: init.body };
		calls.push(call);
		const route = routes.find((r) => r.match(call));
		return { status: route?.status ?? 404, text: async () => (route?.body === undefined ? "" : JSON.stringify(route.body)) };
	};
	return { fn, calls };
}

describe("cloudflare", () => {
	it("acha a zona subindo os rótulos, cria o curinga com proxy e apaga por id; token só no cabeçalho", async () => {
		const { fn, calls } = fakeFetch([
			{ match: (c) => c.url.includes("/zones?name=previas.exemplo.com"), status: 200, body: { result: [] } },
			{ match: (c) => c.url.includes("/zones?name=exemplo.com"), status: 200, body: { result: [{ id: "z1", name: "exemplo.com" }] } },
			{ match: (c) => c.method === "GET" && c.url.includes("/dns_records"), status: 200, body: { result: [] } },
			{ match: (c) => c.method === "POST", status: 200, body: { result: { id: "r1" } } },
			{ match: (c) => c.method === "DELETE", status: 200, body: {} },
		]);
		const cf = cloudflareProvider(TOKEN, fn);
		const zone = await cf.detectZone(DOMAIN);
		expect(zone).toEqual({ id: "z1", name: "exemplo.com" });
		expect(await cf.findWildcard(zone!, DOMAIN)).toBeNull();
		expect(await cf.createWildcard(zone!, DOMAIN, IP, { proxied: true })).toEqual({ id: "r1", content: IP });
		await cf.deleteRecord(zone!, "r1");
		const post = calls.find((c) => c.method === "POST")!;
		expect(post.url).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records");
		expect(JSON.parse(post.body!)).toMatchObject({ type: "A", name: `*.${DOMAIN}`, content: IP, proxied: true });
		expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}` && !c.url.includes(TOKEN) && !(c.body ?? "").includes(TOKEN))).toBe(true);
	});
	it("401 e 429 viram erro claro sem o token", async () => {
		for (const [status, kind] of [[401, "auth"], [429, "rate_limit"]] as const) {
			const cf = cloudflareProvider(TOKEN, fakeFetch([{ match: () => true, status }]).fn);
			const error = await cf.detectZone(DOMAIN).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(DnsProviderError);
			expect((error as DnsProviderError).kind).toBe(kind);
			expect((error as Error).message).not.toContain(TOKEN);
		}
	});
	it("falha de rede não vaza o token", async () => {
		const fn: FetchFn = async () => { throw new Error(`boom ${TOKEN}`); };
		const error = (await cloudflareProvider(TOKEN, fn).detectZone(DOMAIN).catch((e: unknown) => e)) as Error;
		expect(error.message).not.toContain(TOKEN);
	});
});

describe("desec", () => {
	it("usa Token, curinga na zona e id para desfazer", async () => {
		const { fn, calls } = fakeFetch([
			{ match: (c) => c.url.includes("owns_qname=previas.meunome.dedyn.io"), status: 200, body: [] },
			{ match: (c) => c.url.includes("owns_qname=meunome.dedyn.io"), status: 200, body: [{ name: "meunome.dedyn.io" }] },
			{ match: (c) => c.method === "GET" && c.url.includes("/rrsets/"), status: 200, body: [] },
			{ match: (c) => c.method === "POST", status: 201, body: {} },
			{ match: (c) => c.method === "DELETE", status: 204 },
		]);
		const de = desecProvider(TOKEN, fn);
		const zone = await de.detectZone("previas.meunome.dedyn.io");
		expect(zone).toEqual({ id: "meunome.dedyn.io", name: "meunome.dedyn.io" });
		expect(await de.findWildcard(zone!, "previas.meunome.dedyn.io")).toBeNull();
		const created = await de.createWildcard(zone!, "previas.meunome.dedyn.io", IP, { proxied: false });
		expect(created.id).toBe("*.previas|A");
		expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ subname: "*.previas", type: "A", ttl: 3600, records: [IP] });
		await de.deleteRecord(zone!, created.id);
		expect(calls.at(-1)!.url).toBe("https://desec.io/api/v1/domains/meunome.dedyn.io/rrsets/*.previas/A/");
		expect(calls.every((c) => c.headers.authorization === `Token ${TOKEN}`)).toBe(true);
	});
	it("domínio igual à zona usa subname *; 409 vira conflito", async () => {
		const { fn } = fakeFetch([{ match: (c) => c.method === "POST", status: 409 }]);
		const de = desecProvider(TOKEN, fn);
		const error = await de.createWildcard({ id: "a.dedyn.io", name: "a.dedyn.io" }, "a.dedyn.io", IP, { proxied: false }).catch((e: unknown) => e);
		expect((error as DnsProviderError).kind).toBe("conflict");
	});
});

describe("verificações", () => {
	it("DNS: ok, IP errado, sem registro, e proxy (qualquer resposta)", async () => {
		expect((await checkDns("h", IP, async () => [IP])).ok).toBe(true);
		expect(await checkDns("h", IP, async () => ["1.1.1.1"])).toMatchObject({ ok: false, reason: "wrong_ip" });
		expect(await checkDns("h", IP, async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); })).toMatchObject({ ok: false, reason: "no_record" });
		expect((await checkDns("h", null, async () => ["104.0.0.1"])).ok).toBe(true);
	});
	it("TLS: curinga válido, vencido, SAN errado, não confiável", () => {
		const cert = { subjectaltname: `DNS:*.${DOMAIN}, DNS:${DOMAIN}`, valid_to: "Jan  1 00:00:00 2030 GMT", issuer: { O: "Let's Encrypt" } };
		const now = Date.parse("2026-10-30");
		expect(checkTlsFromCert({ authorized: true, cert, baseDomain: DOMAIN, now }).ok).toBe(true);
		expect(checkTlsFromCert({ authorized: true, cert: { ...cert, valid_to: "Jan  1 00:00:00 2020 GMT" }, baseDomain: DOMAIN, now })).toMatchObject({ reason: "expired" });
		expect(checkTlsFromCert({ authorized: true, cert: { ...cert, subjectaltname: "DNS:outro.com" }, baseDomain: DOMAIN, now })).toMatchObject({ reason: "san_mismatch" });
		expect(checkTlsFromCert({ authorized: false, cert, baseDomain: DOMAIN, now })).toMatchObject({ reason: "untrusted" });
		expect(sanCovers("DNS:exemplo.com", DOMAIN)).toBe(false);
	});
	it("probe: 401 da API = ok; 404 do proxy = rota faltando; outro = prévia desligada", async () => {
		const res = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
		expect((await probeApi(DOMAIN, res(401, "Link expirado. Peça o link da prévia de novo no chat."))).kind).toBe("ok");
		expect((await probeApi(DOMAIN, res(404, "404 page not found"))).kind).toBe("route_missing");
		expect((await probeApi(DOMAIN, res(404, '{"error":"not found"}'))).kind).toBe("not_enabled");
		expect((await probeApi(DOMAIN, (async () => { throw new Error("x"); }) as unknown as typeof fetch)).kind).toBe("unreachable");
	});
});

// ---- máquina de passos ----
type World = {
	state: PreviewSetupState | null;
	token: string | null;
	approved: Set<string>;
	cards: Array<{ callKey: string; title: string }>;
	dnsOk: boolean;
	tlsOk: boolean;
	probe: "ok" | "route_missing" | "not_enabled";
	envApplied: boolean;
	records: Map<string, string>; // id -> ip
	log: string[];
};

function world(patch: Partial<World> = {}): World {
	return { state: null, token: TOKEN, approved: new Set(), cards: [], dnsOk: true, tlsOk: true, probe: "ok", envApplied: true, records: new Map(), log: [], ...patch };
}

function depsFor(w: World, overrides: Partial<SetupDeps> = {}): SetupDeps {
	return {
		userId: "admin",
		atlasUrl: "https://atlas.meusite.com",
		now: () => new Date("2026-10-30T12:00:00Z"),
		loadState: async () => w.state,
		saveState: async (s) => { w.state = s; },
		deleteState: async () => { w.state = null; },
		getDnsToken: async () => w.token,
		providerFor: () => ({
			id: "cloudflare",
			automated: true,
			detectZone: async () => ({ id: "z1", name: "exemplo.com" }),
			findWildcard: async () => { const e = [...w.records.entries()][0]; return e ? { id: e[0], content: e[1] } : null; },
			createWildcard: async (_z, _d, ip) => { w.log.push("create"); w.records.set("r1", ip); return { id: "r1", content: ip }; },
			deleteRecord: async (_z, id) => { w.log.push(`delete:${id}`); w.records.delete(id); },
		}),
		checks: {
			dns: async () => ({ ok: w.dnsOk, found: w.dnsOk ? [IP] : [], reason: w.dnsOk ? undefined : "no_record" }),
			tls: async () => (w.tlsOk ? { ok: true, issuer: "LE" } : { ok: false, reason: "unreachable" }),
			probe: async () => ({ kind: w.probe }),
		},
		findApproved: async (k) => w.approved.has(k),
		requestApproval: async (i) => { w.cards.push({ callKey: i.callKey, title: i.title }); return { type: "confirm", callKey: i.callKey }; },
		envApplied: () => w.envApplied,
		sleep: async () => undefined,
		...overrides,
	};
}

const configure = (w: World, extra: Record<string, unknown> = {}) =>
	runSetup(depsFor(w), { action: "configure", domain: DOMAIN, dns_provider: "cloudflare", tls: "dns01-proxy", platform: "dokploy", server_ip: IP, ...extra });

describe("configure", () => {
	it("recusa domínio no mesmo site do Atlas, IP privado e origin-cert fora da Cloudflare", async () => {
		const w = world();
		await expect(configure(w, { domain: "previas.meusite.com" })).rejects.toThrow(/mesmo site|separado/);
		await expect(configure(w, { server_ip: "10.0.0.5" })).rejects.toThrow(/public IPv4/);
		await expect(configure(w, { dns_provider: "desec", tls: "origin-cert" })).rejects.toThrow(/Cloudflare/);
		expect(w.state).toBeNull();
	});
	it("salva o estado e manda pedir o token pelo cartão seguro (nunca no chat)", async () => {
		const w = world();
		const r = await configure(w);
		expect(w.state?.domain).toBe(DOMAIN);
		expect(r.summary).toContain("secret_request");
		expect(r.summary).toContain("preview-dns-token");
	});
});

describe("passo do DNS", () => {
	it("sem token pede o token; com token pede aprovação ANTES de escrever", async () => {
		const w = world({ token: null });
		await configure(w);
		expect((await runSetup(depsFor(w), { action: "run" })).summary).toContain("secret_request");
		w.token = TOKEN;
		const r = await runSetup(depsFor(w), { action: "run" });
		expect(r.confirmEvent).toBeTruthy();
		expect(w.cards).toHaveLength(1);
		expect(w.log).toEqual([]);
	});
	it("aprovado: cria, guarda o id criado, verifica e avança; nenhum resultado carrega o token", async () => {
		const w = world();
		await configure(w);
		await runSetup(depsFor(w), { action: "run" });
		w.approved.add(w.cards[0]!.callKey);
		const r = await runSetup(depsFor(w), { action: "run" });
		expect(w.log).toEqual(["create"]);
		expect(w.state?.steps.dns).toMatchObject({ status: "done", created: { zoneId: "z1", recordIds: ["r1"] } });
		expect(nextSetupStep(w.state!)).toBe("tls");
		expect(JSON.stringify([r, w.state])).not.toContain(TOKEN);
	});
	it("idempotente: registro igual já existe → não escreve nem pede aprovação", async () => {
		const w = world({ records: new Map([["rX", IP]]) });
		await configure(w);
		const r = await runSetup(depsFor(w), { action: "run" });
		expect(r.confirmEvent).toBeUndefined();
		expect(w.log).toEqual([]);
		expect(w.state?.steps.dns.status).toBe("done");
		expect(w.state?.steps.dns.created).toBeUndefined();
	});
	it("registro existente com outro IP: falha sem sobrescrever e marca failed", async () => {
		const w = world({ records: new Map([["rX", "198.51.100.9"]]) });
		await configure(w);
		await expect(runSetup(depsFor(w), { action: "run" })).rejects.toThrow(/will not overwrite/);
		expect(w.log).toEqual([]);
		expect(w.state?.steps.dns.status).toBe("failed");
	});
	it("provedor com 401: falha, estado failed, e dá para tentar de novo", async () => {
		const w = world();
		await configure(w);
		w.approved.add("any");
		const bad = depsFor(w, { providerFor: () => { throw new DnsProviderError("A Cloudflare recusou o token (inválido ou sem a permissão necessária).", "auth"); } });
		await expect(runSetup(bad, { action: "run" })).rejects.toThrow(/recusou o token/);
		expect(w.state?.steps.dns.status).toBe("failed");
		expect(nextSetupStep(w.state!)).toBe("dns");
	});
	it("propagação lenta: criado mas ainda não visível → não avança e retoma depois sem criar de novo", async () => {
		const w = world({ dnsOk: false });
		await configure(w);
		await runSetup(depsFor(w), { action: "run" });
		w.approved.add(w.cards[0]!.callKey);
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state?.steps.dns.status).toBe("pending");
		w.dnsOk = true;
		await runSetup(depsFor(w), { action: "run" });
		expect(w.log).toEqual(["create"]);
		expect(w.state?.steps.dns.status).toBe("done");
	});
	it("DNS manual: dá o registro exato e só avança quando resolve", async () => {
		const w = world({ dnsOk: false });
		await configure(w, { dns_provider: "manual" });
		const r = await runSetup(depsFor(w), { action: "run" });
		expect(r.summary).toContain(`*.${DOMAIN}`);
		expect(r.summary).toContain(IP);
		expect(w.state?.steps.dns.status).toBe("awaiting_user");
		w.dnsOk = true;
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state?.steps.dns.status).toBe("done");
	});
});

describe("passos guiados e teste final", () => {
	async function untilTls(w: World) {
		await configure(w, { dns_provider: "manual" });
		await runSetup(depsFor(w), { action: "run" });
	}
	it("certificado: instruções, depois só passa com verificação real", async () => {
		const w = world({ tlsOk: false });
		await untilTls(w);
		expect((await runSetup(depsFor(w), { action: "run" })).summary).toContain("DNS challenge");
		expect(w.state?.steps.tls.status).toBe("awaiting_user");
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state?.steps.tls.status).toBe("awaiting_user");
		w.tlsOk = true;
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state?.steps.tls.status).toBe("done");
	});
	it("percorre tudo até a prévia completa; variável e reinício só com o aval do usuário", async () => {
		const w = world();
		await untilTls(w);
		const run = (extra: Record<string, unknown> = {}) => runSetup(depsFor(w), { action: "run", ...extra });
		await run(); await run(); // tls
		await run(); await run(); // route
		await run(); // env instruções
		await run({ user_confirms: true });
		await run(); // redeploy instruções
		expect(w.state?.steps.redeploy.status).toBe("awaiting_user");
		await run({ user_confirms: true });
		const final = await run();
		expect(final.summary).toContain("Prévia completa ligada");
		expect(SETUP_STEPS.every((s) => w.state!.steps[s].status === "done")).toBe(true);
	});
	it("o modelo sozinho não pula o aval do usuário (user_confirms sem instruções antes)", async () => {
		const w = world();
		await untilTls(w);
		w.state = withStep(withStep(withStep(w.state!, "tls", { status: "done" }, new Date()), "route", { status: "done" }, new Date()), "env", { status: "pending" }, new Date());
		await runSetup(depsFor(w), { action: "run", user_confirms: true });
		expect(w.state!.steps.env.status).toBe("awaiting_user");
	});
	it("teste final: prévia desligada reabre variável e reinício; worker sem a variável reabre o reinício", async () => {
		const w = world({ probe: "not_enabled" });
		await untilTls(w);
		for (const s of ["tls", "route", "env", "redeploy"] as const) w.state = withStep(w.state!, s, { status: "done" }, new Date());
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state!.steps.env.status).toBe("awaiting_user");
		expect(w.state!.steps.probe.status).not.toBe("done");
		for (const s of ["env", "redeploy"] as const) w.state = withStep(w.state!, s, { status: "done" }, new Date());
		w.probe = "ok";
		w.envApplied = false;
		await runSetup(depsFor(w), { action: "run" });
		expect(w.state!.steps.redeploy.status).toBe("awaiting_user");
	});
});

describe("rollback", () => {
	it("pede aprovação e apaga só o registro que o setup criou", async () => {
		const w = world();
		await configure(w);
		await runSetup(depsFor(w), { action: "run" });
		w.approved.add(w.cards[0]!.callKey);
		await runSetup(depsFor(w), { action: "run" });
		w.records.set("manual-do-usuario", "9.9.9.9");
		const ask = await runSetup(depsFor(w), { action: "rollback" });
		expect(ask.confirmEvent).toBeTruthy();
		expect(w.log).toEqual(["create"]);
		w.approved.add(w.cards[1]!.callKey);
		await runSetup(depsFor(w), { action: "rollback" });
		expect(w.log).toEqual(["create", "delete:r1"]);
		expect(w.records.has("manual-do-usuario")).toBe(true);
		expect(w.state).toBeNull();
	});
	it("sem nada criado pelo Atlas só limpa o estado", async () => {
		const w = world();
		await configure(w);
		const r = await runSetup(depsFor(w), { action: "rollback" });
		expect(r.confirmEvent).toBeUndefined();
		expect(w.state).toBeNull();
	});
});

describe("restrição ao administrador", () => {
	it("não-admin: o executor recusa e nada é lido nem escrito", async () => {
		const w = world();
		await expect(executePreviewSetup({ action: "status" }, { isAdmin: async () => false, deps: depsFor(w, { loadState: async () => { throw new Error("não devia ler"); } }) })).rejects.toThrow(/only the server administrator/);
	});
	it("admin: status vazio orienta a configurar; action inválida falha", async () => {
		const w = world();
		const ctx = { isAdmin: async () => true, deps: depsFor(w) };
		expect((await executePreviewSetup({ action: "status" }, ctx)).summary).toContain("configure");
		await expect(executePreviewSetup({ action: "apagar" }, ctx)).rejects.toThrow(/action must be/);
	});
	it("estado novo começa em dns", () => {
		expect(nextSetupStep(createSetupState({ domain: DOMAIN, dnsProvider: "manual", tls: "dns01-proxy", platform: "generic", serverIp: IP }))).toBe("dns");
	});
});
