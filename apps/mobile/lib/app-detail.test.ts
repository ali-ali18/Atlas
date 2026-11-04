import { describe, expect, it } from "vitest";
import { canSubmitKey, composioDetail, customDetail, isComposioConnected, isConnectionConnected, isNativeConnected, nativeDetail } from "./app-detail";
import type { McpConnection, NativeConnector } from "./apps-parse";

const entry = (over: Partial<NativeConnector> = {}): NativeConnector => ({ id: "firecrawl", name: "Firecrawl", description: "curta", longDescription: "longa", category: "search", icon: "/connectors/firecrawl.svg", authType: "api_key", comingSoon: false, apiKey: { label: "Chave de API Firecrawl", helpUrl: "https://h" }, skills: [], oauthReady: false, connectionId: null, status: null, accountCount: 0, ...over });
const conn = (over: Partial<McpConnection> = {}): McpConnection => ({ id: "c1", catalogId: "firecrawl", name: "Firecrawl", authType: "api_key", status: "connected", accountLabel: "", icon: null, ...over });

describe("nativeDetail", () => {
	it("conector de chave pede a chave (label do catálogo) antes de conectar", () => {
		const detail = nativeDetail(entry());
		expect(detail).toMatchObject({ action: "connect", description: "longa", apiKey: { label: "Chave de API Firecrawl", helpUrl: "https://h" }, disconnectIds: [] });
	});
	it("OAuth pronto não pede chave, mesmo com apiKey no catálogo (GitHub)", () => {
		expect(nativeDetail(entry({ authType: "oauth", oauthReady: true })).apiKey).toBeNull();
	});
	it("OAuth sem env no servidor mas com chave: pede a chave", () => {
		expect(nativeDetail(entry({ authType: "oauth", oauthReady: false })).apiKey).not.toBeNull();
	});
	it("conectado: sem campo de chave, com id para desconectar", () => {
		expect(nativeDetail(entry({ status: "connected", connectionId: "c1" }))).toMatchObject({ action: "connected", apiKey: null, disconnectIds: ["c1"], reauthId: null });
	});
	it("conector de chave com conexão em erro/pendente: mostra o campo de chave e Conectar (nada de reauth), com Desconectar", () => {
		for (const status of ["error", "pending_auth"] as const) {
			expect(nativeDetail(entry({ status, connectionId: "c1" }))).toMatchObject({ action: "connect", reauthId: null, apiKey: { label: "Chave de API Firecrawl" }, disconnectIds: ["c1"] });
		}
	});
	it("OAuth pronto com conexão em erro/pendente: Autorizar usa o reauth da conexão existente", () => {
		expect(nativeDetail(entry({ authType: "oauth", oauthReady: true, status: "error", connectionId: "c1" }))).toMatchObject({ action: "authorize", reauthId: "c1", apiKey: null });
	});
	it("em breve e indisponível trazem aviso simples, sem termos internos", () => {
		expect(nativeDetail(entry({ comingSoon: true })).note).toBe("Este aplicativo chega em breve.");
		const unavailable = nativeDetail(entry({ authType: "oauth", apiKey: null, oauthReady: false }));
		expect(unavailable).toMatchObject({ action: "unavailable", note: "Este aplicativo ainda não está disponível neste servidor." });
		expect(unavailable.note).not.toMatch(/env|oauth|client/i);
	});
});

describe("composioDetail", () => {
	const info = { slug: "asana", name: "Asana", description: "Tarefas", logo: null };
	it("conectar, conectado (com id) e desligado", () => {
		expect(composioDetail(info, [], true)).toMatchObject({ action: "connect", disconnectIds: [] });
		expect(composioDetail(info, [{ id: "k", toolkit: "asana", toolkitName: "Asana", noAuth: false }], true)).toMatchObject({ action: "connected", disconnectIds: ["k"] });
		expect(composioDetail(info, [], false)).toMatchObject({ action: "unavailable", note: "Ative os apps nas Configurações do site." });
	});
	it("duas contas do mesmo app: Desconectar remove as duas", () => {
		const conns = [{ id: "k1", toolkit: "asana", toolkitName: "Asana", noAuth: false }, { id: "k2", toolkit: "asana", toolkitName: "Asana", noAuth: false }, { id: "k3", toolkit: "outro", toolkitName: "Outro", noAuth: false }];
		expect(composioDetail(info, conns, true).disconnectIds).toEqual(["k1", "k2"]);
	});
	it("falha ao ler as conexões: não oferece Conectar (evita conta duplicada), com aviso de erro", () => {
		expect(composioDetail(info, [], true, true)).toMatchObject({ action: "unavailable", note: "Não consegui carregar os apps agora. Tente de novo em instantes." });
	});
	it("já conectado continua desconectável mesmo com Composio desligado agora", () => {
		expect(composioDetail(info, [{ id: "k", toolkit: "asana", toolkitName: "Asana", noAuth: false }], false).action).toBe("connected");
	});
});

describe("customDetail e conferências", () => {
	it("conector próprio", () => {
		expect(customDetail(conn({ catalogId: null, status: "pending_auth", accountLabel: "eu" }))).toMatchObject({ action: "authorize", reauthId: "c1", account: "eu" });
		expect(customDetail(conn({ catalogId: null })).reauthId).toBeNull();
	});
	it("isNativeConnected / isConnectionConnected / isComposioConnected", () => {
		expect(isNativeConnected([conn()], "firecrawl")).toBe(true);
		expect(isNativeConnected([conn({ status: "pending_auth" })], "firecrawl")).toBe(false);
		expect(isNativeConnected([conn()], "github")).toBe(false);
		expect(isConnectionConnected([conn()], "c1")).toBe(true);
		expect(isConnectionConnected([conn({ status: "error" })], "c1")).toBe(false);
		expect(isComposioConnected([{ id: "1", toolkit: "a", toolkitName: "A", noAuth: false }], "a")).toBe(true);
		expect(isComposioConnected([], "a")).toBe(false);
	});
	it("chave vazia ou só espaços não conecta", () => {
		expect(canSubmitKey("")).toBe(false);
		expect(canSubmitKey("   ")).toBe(false);
		expect(canSubmitKey(" abc ")).toBe(true);
	});
});
