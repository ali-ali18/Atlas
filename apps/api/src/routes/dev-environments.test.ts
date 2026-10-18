import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { createDevEnvironmentRoutes } = await import("./dev-environments.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";
const SECRET_VALUE = "valor-super-secreto-123";

type Row = {
	id: string;
	userId: string;
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	testCommand: string | null;
	tier: "small" | "medium" | "large";
	network: "allowlist" | "full" | "off";
	allowlist: string[];
	approvalMode: "ask" | "allowlist" | "auto" | null;
	commandAllowlist: string[];
	sealedSecrets: string | null;
	source: "manual" | "auto";
	userEditedFields: string[];
	createdAt: Date;
	updatedAt: Date;
};

function makeApp(options: { secretBox?: boolean; sessions?: boolean } = {}) {
	const rows: Row[] = [];
	const cleared: string[] = [];
	let accountDefault: string | null = null;
	let verifier = true;
	let n = 0;
	const touch = (row: Row) => ({ ...row, updatedAt: new Date("2026-10-18T10:00:00Z") });
	const deps = {
		list: async (userId: string) => rows.filter((r) => r.userId === userId),
		get: async (id: string, userId: string) => rows.find((r) => r.id === id && r.userId === userId) ?? null,
		getByRepo: async (userId: string, repo: string) => rows.find((r) => r.userId === userId && r.repo === repo) ?? null,
		count: async (userId: string) => rows.filter((r) => r.userId === userId).length,
		create: async (userId: string, fields: Omit<Row, "id" | "userId" | "sealedSecrets" | "createdAt" | "updatedAt" | "source" | "userEditedFields">) => {
			const row: Row = { id: `e${++n}`, userId, source: "manual", userEditedFields: [], ...fields, sealedSecrets: null, createdAt: new Date("2026-10-18T09:00:00Z"), updatedAt: new Date("2026-10-18T09:00:00Z") };
			rows.push(row);
			return row;
		},
		update: async (id: string, userId: string, patch: Partial<Row>) => {
			const row = rows.find((r) => r.id === id && r.userId === userId);
			if (!row) return null;
			Object.assign(row, patch);
			return touch(row);
		},
		remove: async (id: string, userId: string) => {
			const index = rows.findIndex((r) => r.id === id && r.userId === userId);
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		},
		getApprovalDefault: async () => accountDefault,
		setApprovalDefault: async (_userId: string, mode: string | null) => {
			accountDefault = mode;
		},
		getVerifier: async () => verifier,
		setVerifier: async (_userId: string, enabled: boolean) => {
			verifier = enabled;
		},
		secretBoxReady: () => options.secretBox !== false,
		devSessionsEnabled: () => options.sessions !== false,
		// "Cifra" de teste: nada de texto puro no campo selado.
		seal: (secrets: Record<string, string>) => `sealed:${Buffer.from(JSON.stringify(secrets)).toString("base64")}`,
		open: (sealed: string | null) => (sealed ? (JSON.parse(Buffer.from(sealed.slice(7), "base64").toString()) as Record<string, string>) : {}),
		clearCache: async (userId: string, repo: string) => {
			cleared.push(`${userId}:${repo}`);
			return true;
		},
		probe: async (_userId: string, repo: string) =>
			repo === "acme/site" ? { probe: { rootFiles: ["package.json", "pnpm-lock.yaml"], texts: { "package.json": JSON.stringify({ scripts: { test: "x", dev: "y" } }) } } } : { reason: "no_access" },
	};
	const appFor = (userId: string) => {
		const outer = new Hono<AuthEnv>();
		outer.use("*", async (c, next) => {
			c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
			await next();
		});
		outer.route("/", createDevEnvironmentRoutes(deps as never));
		return outer;
	};
	return { appFor, rows, cleared };
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

test("cria com padrões (lista liberada, pequeno) e normaliza o repositório", async () => {
	const { appFor } = makeApp();
	const res = await appFor(USER_A).request("/v1/dev-environments", json({ repo: "https://github.com/Octo/Hello.git", installCommand: " pnpm i " }));
	assert.equal(res.status, 201);
	const body = (await res.json()) as Record<string, unknown>;
	assert.equal(body.repo, "octo/hello");
	assert.equal(body.installCommand, "pnpm i");
	assert.equal(body.tier, "small");
	assert.equal(body.network, "allowlist");
	assert.deepEqual(body.secrets, []);
});

test("valida o corpo (repo, tier, rede, domínio)", async () => {
	const { appFor } = makeApp();
	const app = appFor(USER_A);
	for (const bad of [{ repo: "x" }, { repo: "a/b", tier: "xl" }, { repo: "a/b", network: "tudo" }, { repo: "a/b", allowlist: ["not a domain"] }, { repo: "a/b", installCommand: 5 }]) {
		const res = await app.request("/v1/dev-environments", json(bad));
		assert.equal(res.status, 400, JSON.stringify(bad));
	}
});

test("repositório repetido do mesmo usuário dá 409; outro usuário pode", async () => {
	const { appFor } = makeApp();
	assert.equal((await appFor(USER_A).request("/v1/dev-environments", json({ repo: "a/b" }))).status, 201);
	assert.equal((await appFor(USER_A).request("/v1/dev-environments", json({ repo: "A/B" }))).status, 409);
	assert.equal((await appFor(USER_B).request("/v1/dev-environments", json({ repo: "a/b" }))).status, 201);
});

test("segredo é write-only: devolve só o nome e nunca o valor", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	const put = await app.request(`/v1/dev-environments/${created.id}/secrets/API_KEY`, send("PUT", { value: SECRET_VALUE }));
	assert.equal(put.status, 200);
	const text = await put.text();
	assert.ok(!text.includes(SECRET_VALUE));
	assert.deepEqual((JSON.parse(text) as { secrets: unknown }).secrets, [{ name: "API_KEY", set: true }]);
	assert.ok(!rows[0]!.sealedSecrets!.includes(SECRET_VALUE));
	const list = await (await app.request("/v1/dev-environments")).text();
	assert.ok(!list.includes(SECRET_VALUE));
	assert.ok(list.includes("API_KEY"));
	// substituir mantém os outros; apagar remove
	await app.request(`/v1/dev-environments/${created.id}/secrets/DB_URL`, send("PUT", { value: "outro-valor" }));
	const del = await app.request(`/v1/dev-environments/${created.id}/secrets/API_KEY`, send("DELETE"));
	assert.deepEqual(((await del.json()) as { secrets: unknown }).secrets, [{ name: "DB_URL", set: true }]);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}/secrets/NADA`, send("DELETE"))).status, 404);
});

test("segredo valida nome, valor e a chave de criptografia", async () => {
	const { appFor } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	assert.equal((await app.request(`/v1/dev-environments/${created.id}/secrets/1ruim`, send("PUT", { value: "x" }))).status, 400);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}/secrets/GH_TOKEN`, send("PUT", { value: "x" }))).status, 400);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}/secrets/OK`, send("PUT", { value: "" }))).status, 400);
	const noBox = makeApp({ secretBox: false });
	const other = noBox.appFor(USER_A);
	const env = (await (await other.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	assert.equal((await other.request(`/v1/dev-environments/${env.id}/secrets/OK`, send("PUT", { value: "abc" }))).status, 503);
});

test("recurso de outro usuário responde 404 em todas as rotas", async () => {
	const { appFor } = makeApp();
	const created = (await (await appFor(USER_A).request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	const b = appFor(USER_B);
	assert.equal((await b.request(`/v1/dev-environments/${created.id}`, send("PATCH", { tier: "large" }))).status, 404);
	assert.equal((await b.request(`/v1/dev-environments/${created.id}`, send("DELETE"))).status, 404);
	assert.equal((await b.request(`/v1/dev-environments/${created.id}/secrets/API_KEY`, send("PUT", { value: "abc" }))).status, 404);
	assert.equal((await b.request(`/v1/dev-environments/${created.id}/secrets/API_KEY`, send("DELETE"))).status, 404);
	const list = (await (await b.request("/v1/dev-environments")).json()) as { environments: unknown[] };
	assert.equal(list.environments.length, 0);
});

test("edita parcialmente e apaga", async () => {
	const { appFor } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b", installCommand: "npm ci" }))).json()) as { id: string };
	const patched = await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { tier: "large", network: "off", startCommand: "npm start", allowlist: ["Meu.Registro.com"] }));
	const view = (await patched.json()) as Record<string, unknown>;
	assert.equal(view.tier, "large");
	assert.equal(view.network, "off");
	assert.equal(view.installCommand, "npm ci");
	assert.deepEqual(view.allowlist, ["meu.registro.com"]);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}`, send("DELETE"))).status, 200);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}`, send("DELETE"))).status, 404);
});

test("aprovação de comandos: padrão herda a conta e a lista vem com os comandos de projeto", async () => {
	const { appFor } = makeApp();
	const res = await appFor(USER_A).request("/v1/dev-environments", json({ repo: "octo/hello" }));
	const body = (await res.json()) as { approvalMode: unknown; commandAllowlist: string[] };
	assert.equal(body.approvalMode, null);
	assert.ok(body.commandAllowlist.includes("pnpm test"));
});

test("aprovação de comandos: edita modo e lista, recusa valor inválido e prefixo amplo demais", async () => {
	const { appFor } = makeApp();
	const created = (await (await appFor(USER_A).request("/v1/dev-environments", json({ repo: "octo/hello" }))).json()) as { id: string };
	const ok = await appFor(USER_A).request(`/v1/dev-environments/${created.id}`, send("PATCH", { approvalMode: "ask", commandAllowlist: ["make build", " make   build ", "pnpm test"] }));
	assert.equal(ok.status, 200);
	const body = (await ok.json()) as { approvalMode: string; commandAllowlist: string[] };
	assert.equal(body.approvalMode, "ask");
	assert.deepEqual(body.commandAllowlist, ["make build", "pnpm test"]);
	assert.equal((await appFor(USER_A).request(`/v1/dev-environments/${created.id}`, send("PATCH", { approvalMode: "yolo" }))).status, 400);
	assert.equal((await appFor(USER_A).request(`/v1/dev-environments/${created.id}`, send("PATCH", { commandAllowlist: ["bash"] }))).status, 400);
	const back = await appFor(USER_A).request(`/v1/dev-environments/${created.id}`, send("PATCH", { approvalMode: null }));
	assert.equal(((await back.json()) as { approvalMode: unknown }).approvalMode, null);
});

test("padrão da conta: salva, devolve na lista e valida o modo", async () => {
	const { appFor } = makeApp();
	assert.equal((await appFor(USER_A).request("/v1/dev-environments-defaults", send("PUT", { approvalMode: "auto" }))).status, 200);
	const list = (await (await appFor(USER_A).request("/v1/dev-environments")).json()) as { defaultApprovalMode: unknown };
	assert.equal(list.defaultApprovalMode, "auto");
	assert.equal((await appFor(USER_A).request("/v1/dev-environments-defaults", send("PUT", { approvalMode: "x" }))).status, 400);
});

test("Verificador inteligente: ligado por padrão, liga/desliga sem mexer no modo de aprovação e valida o tipo", async () => {
	const { appFor } = makeApp();
	const listed = async () => (await (await appFor(USER_A).request("/v1/dev-environments")).json()) as { verifierEnabled: boolean; defaultApprovalMode: unknown };
	assert.equal((await listed()).verifierEnabled, true);
	assert.equal((await appFor(USER_A).request("/v1/dev-environments-defaults", send("PUT", { approvalMode: "ask" }))).status, 200);
	assert.equal((await appFor(USER_A).request("/v1/dev-environments-defaults", send("PUT", { verifier: false }))).status, 200);
	const after = await listed();
	assert.equal(after.verifierEnabled, false);
	assert.equal(after.defaultApprovalMode, "ask");
	assert.equal((await appFor(USER_A).request("/v1/dev-environments-defaults", send("PUT", { verifier: "nao" }))).status, 400);
});

test("a lista informa se as sessões de código estão ligadas (para o atalho Testar uma PR)", async () => {
	for (const sessions of [true, false]) {
		const { appFor } = makeApp({ sessions });
		const body = (await (await appFor(USER_A).request("/v1/dev-environments")).json()) as { devSessionsEnabled: boolean };
		assert.equal(body.devSessionsEnabled, sessions);
	}
});

test("segredos em lote: valida tudo antes, sobrescreve, mantém os outros e nunca devolve valores", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	const url = `/v1/dev-environments/${created.id}/secrets`;
	await app.request(`${url}/ANTIGO`, send("PUT", { value: "v-antigo" }));
	const ok = await app.request(url, send("PUT", { entries: [{ name: "API_KEY", value: SECRET_VALUE }, { name: "ANTIGO", value: "novo-valor" }] }));
	assert.equal(ok.status, 200);
	const text = await ok.text();
	assert.ok(!text.includes(SECRET_VALUE) && !text.includes("novo-valor"));
	assert.deepEqual((JSON.parse(text) as { secrets: unknown }).secrets, [{ name: "ANTIGO", set: true }, { name: "API_KEY", set: true }]);
	assert.ok(rows[0]!.sealedSecrets!.length > 0);
	// inválido: nada é salvo e o erro aponta o índice
	const bad = await app.request(url, send("PUT", { entries: [{ name: "BOM", value: "x" }, { name: "1ruim", value: "x" }, { name: "GH_TOKEN", value: "x" }, { name: "VAZIO", value: "" }] }));
	assert.equal(bad.status, 400);
	const errors = ((await bad.json()) as { errors: { index: number }[] }).errors;
	assert.deepEqual(errors.map((e) => e.index), [1, 2, 3]);
	const list = await (await app.request("/v1/dev-environments")).text();
	assert.ok(!list.includes("BOM"));
	assert.equal((await app.request(url, send("PUT", { entries: [] }))).status, 400);
	assert.equal((await app.request(url, send("PUT", {}))).status, 400);
});

test("segredos em lote: dono, chave de criptografia e limite", async () => {
	const { appFor } = makeApp();
	const created = (await (await appFor(USER_A).request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	const url = `/v1/dev-environments/${created.id}/secrets`;
	assert.equal((await appFor(USER_B).request(url, send("PUT", { entries: [{ name: "A", value: "1" }] }))).status, 404);
	const many = Array.from({ length: 31 }, (_, i) => ({ name: `K${i}`, value: "v" }));
	assert.equal((await appFor(USER_A).request(url, send("PUT", { entries: many }))).status, 400);
	const noBox = makeApp({ secretBox: false });
	const other = noBox.appFor(USER_A);
	const made = (await (await other.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	assert.equal((await other.request(`/v1/dev-environments/${made.id}/secrets`, send("PUT", { entries: [{ name: "A", value: "1" }] }))).status, 503);
});

test("detect devolve sugestões do repositório ou vazio sem acesso", async () => {
	const { appFor } = makeApp();
	const app = appFor(USER_A);
	const hit = (await (await app.request("/v1/dev-environments/detect?repo=acme/site")).json()) as { detected: boolean; installCommand: string; startCommand: string; commandAllowlist: string[] };
	assert.equal(hit.detected, true);
	assert.equal(hit.installCommand, "pnpm install --frozen-lockfile");
	assert.equal(hit.startCommand, "pnpm dev");
	assert.ok(hit.commandAllowlist.includes("pnpm test"));
	const miss = (await (await app.request("/v1/dev-environments/detect?repo=outro/repo")).json()) as { detected: boolean; reason: string };
	assert.deepEqual(miss, { detected: false, reason: "no_access" });
});

test("editar pelo formulário marca os campos mudados (o agente não sobrescreve) e a lista mostra a origem", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b", installCommand: "pnpm i" }))).json()) as { id: string; source: string; userEditedFields: string[] };
	assert.equal(created.source, "manual");
	// ambiente automático: simula a linha criada pela detecção
	rows[0]!.source = "auto";
	const patched = await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { installCommand: "npm ci", startCommand: null, tier: "small" }));
	const body = (await patched.json()) as { source: string; userEditedFields: string[] };
	assert.equal(body.source, "auto");
	assert.deepEqual([...body.userEditedFields].sort(), ["installCommand"]);
	// mudar o mesmo valor não marca; mudar outro acrescenta
	const again = (await (await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { tier: "medium" }))).json()) as { userEditedFields: string[] };
	assert.deepEqual([...again.userEditedFields].sort(), ["installCommand", "tier"]);
});

const MASK = "•".repeat(8);

test("bolinhas de volta não sobrescrevem o segredo salvo (unitário e em lote)", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "API_KEY", value: SECRET_VALUE }] }));
	const sealedBefore = rows[0]!.sealedSecrets;

	const single = await app.request(`/v1/dev-environments/${created.id}/secrets/API_KEY`, send("PUT", { value: MASK }));
	assert.equal(single.status, 200);
	assert.equal(rows[0]!.sealedSecrets, sealedBefore);

	const onlyMasked = await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "API_KEY", value: MASK }] }));
	assert.equal(onlyMasked.status, 200);
	assert.deepEqual(((await onlyMasked.json()) as { secrets: unknown }).secrets, [{ name: "API_KEY", set: true }]);
	assert.equal(rows[0]!.sealedSecrets, sealedBefore);

	// misto: o mascarado é ignorado, o novo entra e o antigo continua com o valor real
	const mixed = await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "API_KEY", value: MASK }, { name: "NOVO", value: "abc" }] }));
	assert.equal(mixed.status, 200);
	const stored = JSON.parse(Buffer.from(rows[0]!.sealedSecrets!.slice(7), "base64").toString()) as Record<string, string>;
	assert.deepEqual(stored, { API_KEY: SECRET_VALUE, NOVO: "abc" });
});

test("mascarado sem chave de criptografia não falha: nada a gravar", async () => {
	const { appFor } = makeApp({ secretBox: false });
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	assert.equal((await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "A", value: MASK }] }))).status, 200);
	const real = await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "A", value: "real" }] }));
	assert.equal(real.status, 503);
	assert.match(((await real.json()) as { error: string }).error, /CONNECTOR_ENCRYPTION_KEY/);
});

test("salvar o formulário (PATCH sem segredos) mantém os segredos existentes", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b" }))).json()) as { id: string };
	await app.request(`/v1/dev-environments/${created.id}/secrets`, send("PUT", { entries: [{ name: "API_KEY", value: SECRET_VALUE }] }));
	const sealedBefore = rows[0]!.sealedSecrets;
	const patch = await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { repo: "a/b", installCommand: "pnpm i", tier: "medium", secrets: {}, sealedSecrets: null }));
	assert.equal(patch.status, 200);
	assert.equal(rows[0]!.sealedSecrets, sealedBefore);
	assert.deepEqual(((await patch.json()) as { secrets: unknown }).secrets, [{ name: "API_KEY", set: true }]);
});

test("comando de teste rápido: cria, edita, limpa e marca como editado pelo usuário", async () => {
	const { appFor, rows } = makeApp();
	const app = appFor(USER_A);
	const created = (await (await app.request("/v1/dev-environments", json({ repo: "a/b", testCommand: " pnpm --filter @app/api test " }))).json()) as { id: string; testCommand: string | null };
	assert.equal(created.testCommand, "pnpm --filter @app/api test");
	const patched = await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { testCommand: "make t" }));
	assert.equal(((await patched.json()) as { testCommand: string }).testCommand, "make t");
	assert.ok(rows[0]!.userEditedFields.includes("testCommand"));
	const cleared = await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { testCommand: "  " }));
	assert.equal(((await cleared.json()) as { testCommand: string | null }).testCommand, null);
	assert.equal((await app.request(`/v1/dev-environments/${created.id}`, send("PATCH", { testCommand: 5 }))).status, 400);
});

test("limpar cache do ambiente: só o dono, limpa o volume do usuário+repo", async () => {
	const { appFor, cleared } = makeApp();
	const created = (await (await appFor(USER_A).request("/v1/dev-environments", json({ repo: "octo/hello" }))).json()) as { id: string };
	const other = await appFor(USER_B).request(`/v1/dev-environments/${created.id}/cache`, send("DELETE"));
	assert.equal(other.status, 404);
	assert.deepEqual(cleared, []);
	const res = await appFor(USER_A).request(`/v1/dev-environments/${created.id}/cache`, send("DELETE"));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, cleared: true });
	assert.deepEqual(cleared, [`${USER_A}:octo/hello`]);
	assert.equal((await appFor(USER_A).request("/v1/dev-environments/inexistente/cache", send("DELETE"))).status, 404);
});

test("excluir o ambiente também limpa o cache de dependências", async () => {
	const { appFor, cleared } = makeApp();
	const created = (await (await appFor(USER_A).request("/v1/dev-environments", json({ repo: "octo/hello" }))).json()) as { id: string };
	const res = await appFor(USER_A).request(`/v1/dev-environments/${created.id}`, send("DELETE"));
	assert.equal(res.status, 200);
	assert.deepEqual(cleared, [`${USER_A}:octo/hello`]);
});
