import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createCodingRoutes } from "./server/coding-routes.mjs";
import { createEgressProxy } from "./server/egress-proxy.mjs";

// Servidor HTTP do container de sessão de desenvolvimento. Sem dependências.
// Diferente do control server do desktop, TODA rota (menos /health) exige o
// bearer DEV_SANDBOX_TOKEN gerado pelo gerenciador ao criar o container.

const PORT = Number.parseInt(process.env.DEV_SANDBOX_PORT ?? "3090", 10);
const TOKEN = process.env.DEV_SANDBOX_TOKEN ?? "";

export function isAuthorized(header, token = TOKEN) {
	if (!token || typeof header !== "string") return false;
	const match = /^Bearer (.+)$/.exec(header);
	if (!match) return false;
	const given = Buffer.from(match[1]);
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createDevServer({ token = TOKEN, coding = createCodingRoutes() } = {}) {
	return createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (req.method === "GET" && path === "/health") {
			// Sem dados sensíveis: serve o HEALTHCHECK do Docker e a espera de prontidão.
			const jobs = coding.exec.list().filter((j) => j.running).length;
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, runningJobs: jobs }));
			return;
		}
		if (!isAuthorized(req.headers.authorization, token)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		try {
			if (await coding(req, res)) return;
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		} catch {
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "erro interno" }));
		}
	});
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
	if (!TOKEN) {
		console.error("DEV_SANDBOX_TOKEN ausente: recusando iniciar sem autenticação.");
		process.exit(1);
	}
	// O proxy e os comandos do agente nunca devem derrubar o servidor do container.
	process.on("uncaughtException", (error) => console.error("erro não tratado:", error?.message ?? error));
	const coding = createCodingRoutes();
	// O proxy sempre escuta (só localhost); a política decide se os comandos o usam.
	createEgressProxy(coding.egress).listen().catch((error) => console.error("proxy de saída indisponível:", error.message));
	createDevServer({ coding }).listen(PORT, "0.0.0.0", () => console.log(`dev-sandbox listening on ${PORT}`));
}
