import { describe, expect, it } from "vitest";
import {
	findNativeCatalogEntryForApp,
	nativeLoginConnector,
	parseLoginConnector,
} from "./login-connector.js";

describe("findNativeCatalogEntryForApp", () => {
	it("acha o nativo por id, nome e slug de toolkit do Composio", () => {
		expect(findNativeCatalogEntryForApp("github")?.id).toBe("github");
		expect(findNativeCatalogEntryForApp("Google Calendar")?.id).toBe("google_calendar");
		expect(findNativeCatalogEntryForApp("googledrive")?.id).toBe("google_drive");
	});
	it("app sem conector nativo ou vazio devolve null", () => {
		expect(findNativeCatalogEntryForApp("linear")).toBeNull();
		expect(findNativeCatalogEntryForApp("  ")).toBeNull();
	});
});

describe("parseLoginConnector", () => {
	const github = findNativeCatalogEntryForApp("github")!;
	it("aceita o conector nativo do catálogo (com reconnect)", () => {
		const connector = nativeLoginConnector(github, true);
		expect(connector).toMatchObject({ kind: "native", id: "github", name: "GitHub", icon: "/connectors/github.svg", reconnect: true });
		expect(parseLoginConnector(JSON.parse(JSON.stringify(connector)))).toEqual(connector);
	});
	it("aceita logo HTTPS do Composio e rejeita ícone perigoso", () => {
		const base = { kind: "composio", id: "linear", name: "Linear", description: "Issues" };
		expect(parseLoginConnector({ ...base, icon: "https://logos.composio.dev/l.png" })?.icon).toBe("https://logos.composio.dev/l.png");
		expect(parseLoginConnector({ ...base, icon: "javascript:alert(1)" })?.icon).toBeNull();
		expect(parseLoginConnector({ ...base, icon: "http://x.test/l.png" })?.icon).toBeNull();
		expect(parseLoginConnector({ ...base, icon: "//evil.test/x.svg" })?.icon).toBeNull();
		expect(parseLoginConnector({ ...base, icon: "/../etc/passwd" })?.icon).toBeNull();
	});
	it("rejeita formato inválido", () => {
		expect(parseLoginConnector(null)).toBeNull();
		expect(parseLoginConnector({ kind: "x", id: "a", name: "A" })).toBeNull();
		expect(parseLoginConnector({ kind: "native", id: "../a", name: "A" })).toBeNull();
		expect(parseLoginConnector({ kind: "native", id: "a", name: " " })).toBeNull();
	});
});

describe("parseLoginConnector: noAuth", () => {
	const base = { kind: "composio", id: "exa", name: "Exa", description: "", icon: null };
	it("mantém noAuth só no Composio e só quando é true", () => {
		expect(parseLoginConnector({ ...base, noAuth: true })).toMatchObject({ noAuth: true });
		expect(parseLoginConnector({ ...base, noAuth: "sim" })).not.toHaveProperty("noAuth");
		expect(parseLoginConnector({ ...base, kind: "native", noAuth: true })).not.toHaveProperty("noAuth");
	});
});

describe("conector custom", () => {
	it("valida URL, auth e ícone do proxy", async () => {
		const { parseLoginConnector, parseCustomMcpUrl } = await import("./login-connector.js");
		expect(parseLoginConnector({ kind: "custom", id: "x", name: "X", url: "https://x.example/mcp", auth: "apiKey", icon: "/v1/mcp/icon/x.example" })).toMatchObject({ kind: "custom", auth: "apiKey", icon: "/v1/mcp/icon/x.example" });
		expect(parseLoginConnector({ kind: "custom", id: "x", name: "X", url: "http://x.example/mcp" })).toBeNull();
		expect(parseLoginConnector({ kind: "custom", id: "x", name: "X", url: "https://x.example/mcp", auth: "bogus" })?.auth).toBe("oauth");
		expect(parseCustomMcpUrl("https://127.0.0.1/mcp").ok).toBe(false);
		expect(parseCustomMcpUrl("https://[::1]/mcp").ok).toBe(false);
		expect(parseCustomMcpUrl("https://x.example/mcp").ok).toBe(true);
	});
});
