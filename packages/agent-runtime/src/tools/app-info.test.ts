import { describe, expect, it } from "vitest";
import { APP_INFO_TOOL, APP_INFO_TOPICS, appInfoText, executeAppInfo } from "./app-info.js";
import { P_APP_INFO, assembleSystemPrompt } from "../context/prompt-blocks.js";

describe("app_info", () => {
	it("traz a URL de callback OAuth montada a partir de ATLAS_URL", () => {
		const text = appInfoText("oauth", { ATLAS_URL: "https://agent.example.com/" });
		expect(text).toContain("https://agent.example.com/v1/mcp/oauth/callback");
		expect(text).not.toContain("//v1");
	});

	it("sem ATLAS_URL diz que não está configurada e não inventa endereço", () => {
		const text = appInfoText("oauth", {});
		expect(text).toContain("not configured");
		expect(text).toContain("/v1/mcp/oauth/callback");
		expect(text).not.toMatch(/https?:\/\//);
	});

	it("webhook usa ATLAS_PUBLIC_URL quando existe, senão ATLAS_URL", () => {
		expect(appInfoText("webhooks", { ATLAS_URL: "https://web.example.com", ATLAS_PUBLIC_URL: "https://api.example.com" })).toContain("https://api.example.com/v1/hooks/<hookKey>");
		expect(appInfoText("webhooks", { ATLAS_URL: "https://web.example.com" })).toContain("https://web.example.com/v1/hooks/github");
	});

	it("sem tópico devolve todos; tópico inválido também; nunca vaza segredos do ambiente", () => {
		const env = { ATLAS_URL: "https://x.example.com", ATLAS_HOOK_PEPPER: "pepper-secret", BETTER_AUTH_SECRET: "auth-secret", CONNECTOR_ENCRYPTION_KEY: "enc-secret" };
		const all = appInfoText(undefined, env);
		for (const topic of APP_INFO_TOPICS) expect(appInfoText(topic, env).length).toBeGreaterThan(40);
		expect(appInfoText("nada", env)).toBe(all);
		for (const secret of ["pepper-secret", "auth-secret", "enc-secret"]) expect(all).not.toContain(secret);
		expect(all).toContain("Notificações no celular");
		expect(all).toContain("MCP personalizado");
	});

	it("a tool está registrada, descrita e o prompt do sistema a anuncia", async () => {
		expect(APP_INFO_TOOL.function.name).toBe("app_info");
		expect(APP_INFO_TOOL.function.description).toMatch(/redirect|callback/i);
		expect((await executeAppInfo({ topic: "login" })).summary).toContain("/api/auth/callback/");
		expect(assembleSystemPrompt(new Set())).toContain(P_APP_INFO[0]);
		expect(P_APP_INFO.join(" ").toLowerCase()).not.toContain("atlas");
	});
});
