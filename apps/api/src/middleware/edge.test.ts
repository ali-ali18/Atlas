import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { Hono } = await import("hono");
const { registerEdgeMiddleware } = await import("./edge.js");
const { createPreviewBasicRoutes, createPreviewService } = await import("../routes/previews.js");
const { auth } = await import("../auth.js");
import type { DevSessionRecord } from "@workspace/db";

const ID = "cmabc123def456ghi789jkl01";
const CAP = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NOW = 1_800_000_000_000;
// getConnInfo (limite por IP) lê o socket do Node; `app.request` precisa fornecê-lo.
const env = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };

async function setup() {
	const bodies: string[] = [];
	const upstream = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			bodies.push(body);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ got: body }));
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const port = (upstream.address() as AddressInfo).port;
	const row = {
		id: ID, userId: "user-a", conversationId: "c", repo: null, branch: null, baseBranch: null, status: "RUNNING", tier: "small", containerId: "x",
		todos: [], pr: null, lastError: null, createdAt: new Date(0), updatedAt: new Date(0), lastActiveAt: new Date(0),
		preview: { port, path: "/", startedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), cap: CAP, capIssuedAt: new Date(NOW).toISOString() },
	} as unknown as DevSessionRecord;
	const service = createPreviewService({
		config: { baseDomain: null, scheme: "https", atlasUrl: "https://atlas.test", secret: "s" },
		getSessionById: async () => row,
		getOwnedSession: async () => row,
		resolveContainerHost: async () => "127.0.0.1",
		touch: async () => undefined,
		now: () => NOW,
	});
	// A MESMA função que o index.ts usa: ordem real de cors, limites, requireUser e limite de corpo.
	const app = new Hono();
	registerEdgeMiddleware(app, { corsOrigins: ["http://localhost:3000"] });
	app.route("/", createPreviewBasicRoutes(service));
	app.get("/v1/bots", (c) => c.json({ ok: true }));
	return { app, bodies, close: () => { upstream.close(); upstream.closeAllConnections(); } };
}

test("borda real: preflight de fetch com JSON/POST na previa recebe ACAO * e o sandbox (o cors global nao responde antes)", async () => {
	const { app, close } = await setup();
	const realGetSession = auth.api.getSession;
	auth.api.getSession = (async () => null) as unknown as typeof auth.api.getSession;
	try {
		for (const origin of ["null", "http://localhost:3000", "https://evil.test"]) {
			const res = await app.request(`https://atlas.test/v1/previews/${ID}/p/${CAP}/api/items`, {
				method: "OPTIONS",
				headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-custom" },
			}, env);
			assert.equal(res.status, 204, origin);
			assert.equal(res.headers.get("access-control-allow-origin"), "*", `${origin}: nunca reflete a origem`);
			assert.equal(res.headers.get("access-control-allow-credentials"), null, origin);
			assert.equal(res.headers.get("access-control-allow-headers"), "content-type, x-custom", origin);
			assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/, origin);
			assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads", origin);
			assert.equal(res.headers.get("vary"), null, `${origin}: sem Vary: Origin do cors global`);
		}
	} finally {
		auth.api.getSession = realGetSession;
		close();
	}
});

test("borda real: POST JSON na previa chega ao projeto com os cabecalhos da previa, e o cors global segue valendo fora dela", async () => {
	const { app, bodies, close } = await setup();
	const realGetSession = auth.api.getSession;
	auth.api.getSession = (async () => null) as unknown as typeof auth.api.getSession;
	try {
		const post = await app.request(`https://atlas.test/v1/previews/${ID}/p/${CAP}/api/items`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ a: 1 }) }, env);
		assert.equal(post.status, 200);
		assert.equal(post.headers.get("access-control-allow-origin"), "*");
		assert.match(post.headers.get("content-security-policy") ?? "", /^sandbox /);
		assert.deepEqual(bodies, ['{"a":1}']);

		const other = await app.request("https://atlas.test/v1/bots", { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } }, env);
		assert.equal(other.status, 204);
		assert.equal(other.headers.get("access-control-allow-origin"), "http://localhost:3000", "CORS do Atlas intacto fora da prévia");
		assert.equal(other.headers.get("content-security-policy"), null);
	} finally {
		auth.api.getSession = realGetSession;
		close();
	}
});
