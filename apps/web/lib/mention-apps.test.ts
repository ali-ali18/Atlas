import assert from "node:assert/strict";
import test from "node:test";
import { buildMentionApps, visibleMentionApps } from "./mention-apps";
import { triggerState } from "./mention-input";

const sources = {
	catalog: [
		{ id: "gmail", name: "Gmail", description: "E-mail", icon: "/connectors/gmail.svg", availability: "available", status: "connected" },
		{ id: "notion", name: "Notion", description: "Notas", icon: "/connectors/notion.svg", availability: "available", status: null },
		{ id: "futuro", name: "Futuro", description: "", icon: "/connectors/x.svg", availability: "coming_soon", status: null },
	],
	connections: [
		{ id: "c1", catalogId: "gmail", name: "Gmail", url: "https://x.example/mcp", status: "connected" as const },
		{ id: "c2", catalogId: null, name: "Meu Servidor", url: "https://mcp.exemplo.com/sse", status: "connected" as const },
		{ id: "c3", catalogId: null, name: "Servidor Parado", url: "https://parado.exemplo.com/mcp", status: "pending_auth" as const },
	],
	composioConnections: [{ id: "k1", toolkit: "linear", toolkitName: "Linear" }, { id: "k2", toolkit: "asana", toolkitName: "Asana" }],
	composioToolkits: [
		{ slug: "linear", name: "Linear", description: null, logo: "https://logos.example/linear.svg", connected: true, noAuth: false, nativeCatalogId: null },
		{ slug: "googlecalendar", name: "Google Calendar", description: null, logo: null, connected: false, noAuth: false, nativeCatalogId: "google_calendar" },
		{ slug: "trello", name: "Trello", description: null, logo: "https://logos.example/trello.svg", connected: false, noAuth: false, nativeCatalogId: null },
	],
};

test("monta a lista única de apps: catálogo, MCP próprio e Composio, sem duplicar nem listar o que não está disponível", () => {
	const apps = buildMentionApps(sources);
	const byName = new Map(apps.map((app) => [app.name, app]));
	assert.equal(byName.get("Gmail")?.connected, true);
	assert.equal(byName.get("Gmail")?.logo, "/connectors/gmail.svg");
	assert.equal(byName.get("Notion")?.connected, false);
	assert.ok(!byName.has("Futuro"), "em breve não entra");
	assert.equal(byName.get("Meu Servidor")?.logo, "/v1/mcp/icon/mcp.exemplo.com");
	assert.equal(byName.get("Servidor Parado")?.connected, false);
	assert.equal(byName.get("Linear")?.logo, "https://logos.example/linear.svg");
	assert.equal(byName.get("Asana")?.connected, true, "conectado fora da 1ª página do catálogo entra sem logo");
	assert.equal(byName.get("Asana")?.logo, null);
	assert.ok(!byName.has("Google Calendar"), "tem conector nativo equivalente: não duplica");
	assert.equal(apps.filter((app) => app.name === "Gmail").length, 1);
});

test("sem consulta só os conectados; com consulta os que casam, conectados ou não; nome de bot vence", () => {
	const apps = buildMentionApps(sources);
	assert.deepEqual(visibleMentionApps(apps, "").map((app) => app.name).sort(), ["Asana", "Gmail", "Linear", "Meu Servidor"]);
	assert.deepEqual(visibleMentionApps(apps, "not").map((app) => app.name), ["Notion"]);
	assert.deepEqual(visibleMentionApps(apps, "servidor").map((app) => app.name).sort(), ["Meu Servidor", "Servidor Parado"]);
	assert.deepEqual(visibleMentionApps(apps, "zzz"), []);
	assert.ok(!visibleMentionApps(apps, "", ["gmail"]).some((app) => app.name === "Gmail"));
});

test("@ do composer: bots primeiro e depois apps; estado vazio só sem bot e sem app", () => {
	const apps = buildMentionApps(sources).map((app) => ({ ...app, description: app.description ?? null }));
	const bots = [{ id: "b1", name: "Bia", description: null, logo: null, connected: false }];
	const all = triggerState("oi @", 4, { skills: [], bots, apps });
	assert.equal(all?.candidates[0]?.id, "b1");
	assert.ok(all?.candidates.slice(1).every((candidate) => candidate.id.includes(":")));
	assert.deepEqual(triggerState("@not", 4, { skills: [], bots, apps })?.candidates.map((c) => c.name), ["Notion"]);
	assert.deepEqual(triggerState("@zzz", 4, { skills: [], bots, apps })?.candidates, []);
	const clash = triggerState("@gm", 3, { skills: [], bots: [{ id: "b2", name: "Gmail", description: null, logo: null, connected: false }], apps });
	assert.deepEqual(clash?.candidates.map((c) => c.id), ["b2"], "bot com o mesmo nome do app vence");
});
