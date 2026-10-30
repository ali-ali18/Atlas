import { describe, expect, it } from "vitest";
import {
	approxRegistrableDomain,
	previewBaseDomainConflict,
	isPreviewPort,
	normalizePreviewBaseDomain,
	normalizePreviewPath,
	previewIdFromHost,
	previewOrigin,
} from "./preview.js";

const ID = "cmabc123def456ghi789jkl01";

describe("isPreviewPort", () => {
	it.each([1024, 3000, 5173, 8080, 65535])("aceita %i", (port) => expect(isPreviewPort(port)).toBe(true));
	it.each([0, 22, 80, 1023, 65536, 3090, 3128, 3129, 3000.5, -1, NaN])("recusa %s", (port) => expect(isPreviewPort(port)).toBe(false));
	it("recusa o que não é número", () => {
		expect(isPreviewPort("3000")).toBe(false);
		expect(isPreviewPort(undefined)).toBe(false);
	});
});

describe("normalizePreviewPath", () => {
	it("vazio vira raiz e acrescenta a barra", () => {
		expect(normalizePreviewPath(undefined)).toBe("/");
		expect(normalizePreviewPath("")).toBe("/");
		expect(normalizePreviewPath("sobre?x=1")).toBe("/sobre?x=1");
	});
	it("recusa open redirect, controle e tamanho", () => {
		expect(normalizePreviewPath("//evil.com")).toBeNull();
		expect(normalizePreviewPath("/\\evil.com")).toBeNull();
		expect(normalizePreviewPath("/a\nb")).toBeNull();
		expect(normalizePreviewPath(`/${"a".repeat(250)}`)).toBeNull();
		expect(normalizePreviewPath(42)).toBeNull();
	});
});

describe("normalizePreviewBaseDomain", () => {
	it("limpa esquema, curinga e barra", () => {
		expect(normalizePreviewBaseDomain("https://*.Preview.Example.com/")).toBe("preview.example.com");
		expect(normalizePreviewBaseDomain("preview.localhost:3001")).toBe("preview.localhost:3001");
	});
	it("recusa vazio e inválido", () => {
		expect(normalizePreviewBaseDomain(undefined)).toBeNull();
		expect(normalizePreviewBaseDomain("  ")).toBeNull();
		expect(normalizePreviewBaseDomain("a b.com")).toBeNull();
		expect(normalizePreviewBaseDomain("evil.com/path")).toBeNull();
	});
});

describe("previewIdFromHost", () => {
	const base = "preview.example.com";
	it("extrai o id do subdomínio", () => {
		expect(previewIdFromHost(`${ID}.${base}`, base)).toBe(ID);
		expect(previewIdFromHost(`${ID.toUpperCase()}.${base}`, base)).toBe(ID);
	});
	it("não casa: apex, outro domínio, subnível, id curto, sem base", () => {
		expect(previewIdFromHost(base, base)).toBeNull();
		expect(previewIdFromHost(`${ID}.other.com`, base)).toBeNull();
		expect(previewIdFromHost(`x.${ID}.${base}`, base)).toBeNull();
		expect(previewIdFromHost(`abc.${base}`, base)).toBeNull();
		expect(previewIdFromHost(`${ID}.${base}`, null)).toBeNull();
		expect(previewIdFromHost(undefined, base)).toBeNull();
		expect(previewIdFromHost(`${ID}.${base}.evil.com`, base)).toBeNull();
	});
	it("respeita a porta do domínio-base", () => {
		expect(previewIdFromHost(`${ID}.preview.localhost:3001`, "preview.localhost:3001")).toBe(ID);
		expect(previewIdFromHost(`${ID}.preview.localhost`, "preview.localhost:3001")).toBeNull();
	});
});

describe("previewOrigin", () => {
	it("monta a origem", () => {
		expect(previewOrigin({ scheme: "https", baseDomain: "p.example.com", id: ID })).toBe(`https://${ID}.p.example.com`);
	});
});

describe("previewBaseDomainConflict", () => {
	it("recusa o mesmo host, domínio pai e mesmo site", () => {
		expect(previewBaseDomainConflict("atlas.example.com", "https://atlas.example.com")).toMatch(/pai|Atlas/);
		expect(previewBaseDomainConflict("example.com", "https://atlas.example.com")).not.toBeNull();
		expect(previewBaseDomainConflict("preview.example.com", "https://atlas.example.com")).toMatch(/mesmo site/);
		expect(previewBaseDomainConflict("p.meusite.com.br", "https://atlas.meusite.com.br")).toMatch(/mesmo site/);
	});
	it("aceita domínio registrável separado, inclusive com sufixo de dois níveis", () => {
		expect(previewBaseDomainConflict("atlas-previews.app", "https://atlas.example.com")).toBeNull();
		expect(previewBaseDomainConflict("p.outro.com.br", "https://atlas.meusite.com.br")).toBeNull();
		expect(previewBaseDomainConflict("preview.localhost:3001", "http://localhost:3000")).toBeNull();
	});
	it("domínio registrável aproximado", () => {
		expect(approxRegistrableDomain("a.b.example.com")).toBe("example.com");
		expect(approxRegistrableDomain("a.b.example.com.br")).toBe("example.com.br");
	});
});
