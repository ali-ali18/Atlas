import { describe, expect, it } from "vitest";
import { MCP_CATALOG, applyMcpApiKey, getMcpCatalogEntry, publicMcpUrl } from "./mcp-catalog.js";

describe("catálogo MCP", () => {
	it("mantém a chave Firecrawl fora da URL pública", () => {
		const entry = getMcpCatalogEntry("firecrawl");
		expect(entry).toBeDefined();
		const key = "fc-test/secret?token";
		const applied = applyMcpApiKey(entry!, key);
		expect(applied.url).toContain(encodeURIComponent(key));
		expect(publicMcpUrl(entry!)).toBe("https://mcp.firecrawl.dev/***/v2/mcp");
		expect(publicMcpUrl(entry!)).not.toContain(key);
	});

	it("envia PAT do GitHub somente no header Bearer", () => {
		const entry = getMcpCatalogEntry("github");
		expect(entry).toBeDefined();
		const applied = applyMcpApiKey(entry!, "test-pat");
		expect(applied.url).toBe("https://api.githubcopilot.com/mcp/");
		expect(applied.headers).toEqual({ Authorization: "Bearer test-pat" });
		expect(publicMcpUrl(entry!)).not.toContain("test-pat");
	});

	it("configura Higgsfield como servidor MCP remoto com login OAuth", () => {
		const entry = getMcpCatalogEntry("higgsfield");
		expect(entry).toMatchObject({
			category: "creative",
			icon: "/connectors/higgsfield.svg",
			authType: "oauth",
			url: "https://mcp.higgsfield.ai/mcp",
			oauth: {},
			availability: "available",
		});
		expect(entry?.apiKey).toBeUndefined();
		expect(publicMcpUrl(entry!)).toBe("https://mcp.higgsfield.ai/mcp");
	});

	it("oferece metadados e habilidades com identificadores únicos para as onze entradas", () => {
		expect(MCP_CATALOG).toHaveLength(11);
		const ids = new Set<string>();
		const skillKeys = new Set<string>();
		for (const entry of MCP_CATALOG) {
			expect(ids.has(entry.id)).toBe(false);
			ids.add(entry.id);
			expect(entry.longDescription.length).toBeGreaterThan(entry.description.length);
			expect(entry.developer).toBeTruthy();
			expect(entry.website).toBeTruthy();
			expect(() => new URL(entry.sourceUrl)).not.toThrow();
			expect(entry.skills.length).toBeGreaterThanOrEqual(2);
			expect(entry.skills.length).toBeLessThanOrEqual(3);
			for (const skill of entry.skills) {
				expect(skill.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
				expect(skillKeys.has(skill.key)).toBe(false);
				skillKeys.add(skill.key);
				expect(skill.title).toBeTruthy();
				expect(skill.description).toBeTruthy();
			}
		}
	});
});

describe("brapi (fonte de dados com chave)", () => {
	it("é uma fonte de dados sem servidor MCP, com chave em Bearer e sem URL de tools", () => {
		const entry = getMcpCatalogEntry("brapi");
		expect(entry).toMatchObject({ kind: "data_source", authType: "api_key", category: "data", availability: "available" });
		expect(entry?.url).toBeUndefined();
		expect(applyMcpApiKey(entry!, "k-123456")).toEqual({ url: "" });
		expect(publicMcpUrl(entry!)).toBe("https://brapi.dev");
		expect(publicMcpUrl(entry!)).not.toContain("k-123456");
	});
});
