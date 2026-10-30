import { describe, expect, it, vi } from "vitest";
import type { DevSessionPreview } from "@workspace/shared";
import {
	PREVIEW_TOOLS,
	parsePreviewStartArgs,
	previewLinkConfigFromEnv,
	previewOpenUrl,
	startPreview,
	stopPreview,
	type PreviewContext,
} from "./preview.js";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const link = { baseDomain: "preview.example.com", atlasUrl: "https://atlas.example.com" };

function ctx(overrides: Partial<PreviewContext> & { stdout?: string; saved?: Array<DevSessionPreview | null> } = {}) {
	const saved = overrides.saved ?? [];
	const client = {
		execStart: vi.fn(async () => ({ id: "0123456789ab" })),
		execPoll: vi.fn(async () => ({ stdout: overrides.stdout ?? "LOOPBACK_DOWN\n" }) as never),
	};
	const context: PreviewContext = {
		link,
		connectMode: "network",
		sessionId: "cmabc123def456ghi789jkl01",
		endpoint: { baseUrl: "http://172.18.0.9:3090", token: "t" },
		client,
		reachable: async () => true,
		now: () => NOW,
		save: async (preview) => void saved.push(preview),
		...overrides,
	};
	return { context, client, saved };
}

describe("definição das tools", () => {
	it("têm quando usar / quando não usar, em inglês, sem o nome do produto", () => {
		expect(PREVIEW_TOOLS.map((t) => t.function.name)).toEqual(["preview_start", "preview_stop"]);
		const text = JSON.stringify(PREVIEW_TOOLS);
		expect(text).toMatch(/USE /);
		expect(text).toMatch(/Do NOT use/);
		expect(text).not.toMatch(/atlas/i);
	});
});

describe("parsePreviewStartArgs", () => {
	it("aceita porta e caminho, com padrão /", () => {
		expect(parsePreviewStartArgs({ port: 5173 })).toEqual({ port: 5173, path: "/" });
		expect(parsePreviewStartArgs({ port: "8080", path: "docs" })).toEqual({ port: 8080, path: "/docs" });
	});
	it("recusa porta reservada, baixa, fora da faixa e tipo errado, com a faixa aceita na mensagem", () => {
		for (const port of [3090, 3128, 3129, 80, 1023, 65536, 3000.5, "abc", undefined, null]) {
			expect(() => parsePreviewStartArgs({ port })).toThrow(/1024 to 65535/);
		}
	});
	it("recusa caminho com open redirect ou comprido demais", () => {
		expect(() => parsePreviewStartArgs({ port: 3000, path: "//evil.com" })).toThrow(/path/);
		expect(() => parsePreviewStartArgs({ port: 3000, path: `/${"a".repeat(300)}` })).toThrow(/path/);
	});
});

describe("previewLinkConfigFromEnv / previewOpenUrl", () => {
	it("exige domínio e ATLAS_URL", () => {
		expect(previewLinkConfigFromEnv({})).toBeNull();
		expect(previewLinkConfigFromEnv({ ATLAS_PREVIEW_BASE_DOMAIN: "p.example.net" })).toBeNull();
		expect(previewLinkConfigFromEnv({ ATLAS_PREVIEW_BASE_DOMAIN: "p.example.net", ATLAS_URL: "https://a.example.com/" })).toEqual({ baseDomain: "p.example.net", atlasUrl: "https://a.example.com" });
		// Mesmo site do Atlas: desligada, salvo o escape hatch.
		expect(previewLinkConfigFromEnv({ ATLAS_PREVIEW_BASE_DOMAIN: "p.example.com", ATLAS_URL: "https://a.example.com" })).toBeNull();
		expect(previewLinkConfigFromEnv({ ATLAS_PREVIEW_BASE_DOMAIN: "p.example.com", ATLAS_URL: "https://a.example.com", ATLAS_PREVIEW_ALLOW_SAME_SITE: "1" })).not.toBeNull();
	});
	it("o link passa pelo Atlas, nunca por endereço interno", () => {
		expect(previewOpenUrl(link, "cmabc123def456ghi789jkl01")).toBe("https://atlas.example.com/v1/previews/cmabc123def456ghi789jkl01/open");
	});
});

describe("startPreview", () => {
	it("porta responde: grava a prévia (1 h) e devolve só o link do Atlas", async () => {
		const { context, saved } = ctx();
		const summary = await startPreview(context, { port: 5173, path: "/sobre" });
		expect(saved).toEqual([{ port: 5173, path: "/sobre", startedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString() }]);
		expect(summary).toContain("https://atlas.example.com/v1/previews/cmabc123def456ghi789jkl01/open");
		expect(summary).not.toMatch(/172\.18|127\.0\.0\.1|localhost:|3090/);
	});

	it("sem domínio configurado falha com mensagem honesta e não grava nada", async () => {
		const { context, saved } = ctx({ link: null });
		await expect(startPreview(context, { port: 5173 })).rejects.toThrow(/not available on this server/);
		expect(saved).toEqual([]);
	});

	it("sem rede compartilhada (portas publicadas) também recusa, sem plano B", async () => {
		const { context, saved } = ctx({ connectMode: "published" });
		await expect(startPreview(context, { port: 5173 })).rejects.toThrow(/not available on this server/);
		expect(saved).toEqual([]);
	});

	it("porta bloqueada falha antes de tocar na rede", async () => {
		const reachable = vi.fn(async () => true);
		const { context, saved } = ctx({ reachable });
		await expect(startPreview(context, { port: 3090 })).rejects.toThrow(/port must be/);
		expect(reachable).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});

	it("serve só no 127.0.0.1: diz para ligar em 0.0.0.0", async () => {
		const { context, client, saved } = ctx({ reachable: async () => false, stdout: "LOOPBACK_UP\n" });
		await expect(startPreview(context, { port: 5173 })).rejects.toThrow(/only on 127\.0\.0\.1.*0\.0\.0\.0/s);
		expect(client.execStart).toHaveBeenCalledTimes(1);
		expect(saved).toEqual([]);
	});

	it("nada escutando: pede para subir o servidor primeiro", async () => {
		const { context, saved } = ctx({ reachable: async () => false });
		await expect(startPreview(context, { port: 5173 })).rejects.toThrow(/Nothing is listening on port 5173/);
		expect(saved).toEqual([]);
	});

	it("o destino da checagem é o IP do container, nunca outro endereço", async () => {
		const reachable = vi.fn(async () => true);
		const { context } = ctx({ reachable });
		await startPreview(context, { port: 4000 });
		expect(reachable).toHaveBeenCalledWith("172.18.0.9", 4000);
	});
});

describe("stopPreview", () => {
	it("limpa a prévia e diz o que aconteceu", async () => {
		const saved: Array<DevSessionPreview | null> = [];
		expect(await stopPreview({ save: async (p) => void saved.push(p) }, true)).toMatch(/closed/);
		expect(await stopPreview({ save: async (p) => void saved.push(p) }, false)).toMatch(/no active preview/);
		expect(saved).toEqual([null, null]);
	});
});
