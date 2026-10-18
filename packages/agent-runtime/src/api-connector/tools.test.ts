import { describe, expect, it } from "vitest";
import { parseOpenApiDocument } from "@workspace/shared";
import { proposeApiConnection, type ProposeApiContext, type ProposeApiDeps } from "./tools.js";
import { SPEC_URL, blingLikeSpec } from "./fixtures.js";

const parsed = parseOpenApiDocument(blingLikeSpec, { specUrl: SPEC_URL });
if (!parsed.ok) throw new Error(parsed.error);
const deps: ProposeApiDeps = {
	discover: async (url) => ({ spec: parsed.spec, specUrl: url, crossHost: false }),
	listConnections: async () => [],
	redirectUrl: () => "https://app.test/v1/mcp/oauth/callback",
};
const ctx = (extra: Partial<ProposeApiContext>): ProposeApiContext => ({ userId: "u1", runId: "r1", origin: "chat", loginAsked: new Set(), ...extra });

describe("propose_api_connection: de onde vem o link", () => {
	it("link digitado pelo usuário: card sem aviso de 'encontrado pelo bot'", async () => {
		const result = await proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText: `conecta ${SPEC_URL}` }), deps);
		expect(result.loginEvent?.connector.api?.foundByBot).toBeUndefined();
	});

	it("link mostrado pelo bot + confirmação curta: card marcado como encontrado pelo bot", async () => {
		for (const text of ["Conecta pra mim", "pode conectar", "sim", "isso"]) {
			const result = await proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText: text, recentAssistantTexts: [`Achei a especificação: ${SPEC_URL}`] }), deps);
			expect(result.loginEvent?.connector.api?.foundByBot).toBe(true);
		}
	});

	it("link do bot sem confirmação (ou com outro link, ou longo): recusado", async () => {
		const recentAssistantTexts = [`Achei: ${SPEC_URL}`];
		for (const lastUserText of ["o que é isso?", "pode conectar https://outro.test/x.json", "x".repeat(80), ""]) {
			await expect(proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText, recentAssistantTexts }), deps)).rejects.toThrow(/must come from/);
		}
	});

	it("link que só existe em resultado de tool / página (não mostrado ao usuário): recusado", async () => {
		await expect(proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText: "conecta pra mim", recentAssistantTexts: ["Vou pesquisar."] }), deps)).rejects.toThrow(/must come from/);
		await expect(proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText: "conecta pra mim" }), deps)).rejects.toThrow(/must come from/);
	});

	it("API OAuth2: o resultado manda citar o endereço de retorno em uma linha", async () => {
		const result = await proposeApiConnection({ url: SPEC_URL }, ctx({ lastUserText: `conecta ${SPEC_URL}` }), deps);
		expect(result.summary).toContain("Cadastre no app da API o endereço de retorno: https://app.test/v1/mcp/oauth/callback");
	});
});
