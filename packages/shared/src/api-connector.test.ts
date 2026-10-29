import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	allowedApiOperations,
	buildApiRequestUrl,
	extractUrls,
	API_AUTH_LABEL,
	isShortConnectConfirmation,
	parseOpenApiDocument,
	readableApiTags,
	searchApiOperations,
	slugifyApiName,
	summarizeApiGroups,
	urlInUserText,
	type ApiOperation,
} from "./api-connector.js";
import { parseApiProposal } from "./api-proposal.js";
import { parseLoginConnector } from "./login-connector.js";

const SPEC_URL = "https://docs.exemplo.com.br/openapi.json";

const oas3 = {
	openapi: "3.0.3",
	info: { title: "Exemplo ERP", description: "ERP de teste" },
	servers: [{ url: "https://{host}/Api/v3", variables: { host: { default: "api.exemplo.com.br" } } }],
	security: [{ OAuth2: [] }],
	components: {
		securitySchemes: {
			Key: { type: "apiKey", in: "header", name: "X-Api-Key" },
			OAuth2: {
				type: "oauth2",
				flows: {
					authorizationCode: {
						authorizationUrl: "https://www.exemplo.com.br/oauth/authorize",
						tokenUrl: "https://www.exemplo.com.br/oauth/token",
						scopes: { "pedidos.read": "Ler pedidos" },
					},
				},
			},
		},
		parameters: { Pagina: { name: "pagina", in: "query", schema: { type: "integer" } } },
	},
	paths: {
		"/pedidos/vendas": {
			parameters: [{ $ref: "#/components/parameters/Pagina" }],
			get: { operationId: "getPedidosVendas", tags: ["Pedidos de Vendas"], summary: "Lista pedidos", parameters: [{ name: "situacao", in: "query", schema: { type: "string", enum: ["aberto", "atendido"] } }] },
			post: { operationId: "postPedidosVendas", tags: ["Pedidos de Vendas"], summary: "Cria pedido", requestBody: {} },
		},
		"/pedidos/vendas/{idPedidoVenda}": {
			get: { tags: ["Pedidos de Vendas"], summary: "Obtém um pedido", parameters: [{ name: "idPedidoVenda", in: "path", required: true, schema: { type: "integer" } }] },
			delete: { operationId: "deletePedido", tags: ["Pedidos de Vendas"] },
		},
		"/produtos": { get: { operationId: "getProdutos", tags: ["Produtos"], summary: "Lista produtos" } },
	},
};

const swagger2 = {
	swagger: "2.0",
	info: { title: "Loja Antiga" },
	host: "api.loja.example",
	basePath: "/v1",
	schemes: ["http", "https"],
	securityDefinitions: { q: { type: "apiKey", in: "query", name: "api_key" } },
	paths: { "/itens/{id}": { get: { operationId: "getItem", parameters: [{ name: "id", in: "path", required: true, type: "string" }, { name: "x", in: "body" }] } } },
};

function parseOk(doc: unknown, specUrl = SPEC_URL) {
	const result = parseOpenApiDocument(doc, { specUrl });
	if (!result.ok) throw new Error(result.error);
	return result.spec;
}

describe("parseOpenApiDocument", () => {
	it("interpreta OpenAPI 3 com servidor parametrizado, oauth2 e parâmetros por $ref", () => {
		const spec = parseOk(oas3);
		expect(spec.baseUrl).toBe("https://api.exemplo.com.br/Api/v3");
		expect(spec.title).toBe("Exemplo ERP");
		expect(spec.auth).toMatchObject({ kind: "oauth2", authorizeUrl: "https://www.exemplo.com.br/oauth/authorize", tokenUrl: "https://www.exemplo.com.br/oauth/token", scopes: ["pedidos.read"] });
		expect(spec.operations).toHaveLength(5);
		const list = spec.operations.find((op) => op.id === "getPedidosVendas")!;
		expect(list.params.map((param) => param.name)).toEqual(["pagina", "situacao"]);
		expect(list.params[1]!.enum).toEqual(["aberto", "atendido"]);
		const one = spec.operations.find((op) => op.method === "GET" && op.path.endsWith("{idPedidoVenda}"))!;
		expect(one.id).toBe("get_pedidos_vendas_idPedidoVenda");
		expect(one.params[0]).toMatchObject({ name: "idPedidoVenda", in: "path", required: true });
		expect(spec.operations.find((op) => op.id === "postPedidosVendas")!.body).toBe(true);
	});

	it("interpreta Swagger 2 (host, basePath, https preferido, apiKey em query)", () => {
		const spec = parseOk(swagger2, "https://api.loja.example/swagger.json");
		expect(spec.baseUrl).toBe("https://api.loja.example/v1");
		expect(spec.auth).toEqual({ kind: "apiKey", in: "query", name: "api_key" });
		expect(spec.operations[0]!.params).toEqual([{ name: "id", in: "path", required: true, type: "string" }]);
		expect(spec.operations[0]!.body).toBe(true);
	});

	it("sem esquema de segurança vira none; bearer http é reconhecido", () => {
		expect(parseOk({ ...oas3, security: undefined, components: {} }).auth.kind).toBe("none");
		const bearer = { ...oas3, security: undefined, components: { securitySchemes: { b: { type: "http", scheme: "Bearer" } } } };
		expect(parseOk(bearer).auth.kind).toBe("bearer");
	});

	it.each([
		["não é objeto", "texto"],
		["versão errada", { openapi: "1.0", paths: {} }],
		["sem paths", { openapi: "3.0.0" }],
		["sem operações", { openapi: "3.0.0", paths: { "/x": {} } }],
		["base privada", { ...oas3, servers: [{ url: "https://10.0.0.5/api" }] }],
		["base http", { ...oas3, servers: [{ url: "http://api.exemplo.com.br" }] }],
		["base localhost", { ...oas3, servers: [{ url: "https://localhost/api" }] }],
	])("recusa %s", (_label, doc) => {
		expect(parseOpenApiDocument(doc, { specUrl: SPEC_URL }).ok).toBe(false);
	});

	it("ignora caminhos que tentam sair da base e deduplica ids", () => {
		const doc = { ...oas3, paths: { "//evil.com/x": { get: {} }, "/a": { get: { operationId: "dup" } }, "/b": { get: { operationId: "dup" } } } };
		const spec = parseOk(doc);
		expect(spec.operations.map((op) => op.id)).toEqual(["dup", "dup_2"]);
	});
});

describe("grupos e acesso", () => {
	const spec = parseOk(oas3);
	it("conta leitura e escrita por grupo e só libera leitura", () => {
		expect(summarizeApiGroups(spec.operations)).toEqual([
			{ tag: "Pedidos de Vendas", total: 4, read: 2, write: 2 },
			{ tag: "Produtos", total: 1, read: 1, write: 0 },
		]);
		expect(readableApiTags(spec.operations)).toEqual(["Pedidos de Vendas", "Produtos"]);
		const allowed = allowedApiOperations(spec.operations, ["Pedidos de Vendas"]);
		expect(allowed.every((op) => op.method === "GET" && op.tag === "Pedidos de Vendas")).toBe(true);
		expect(allowed).toHaveLength(2);
	});
	it("busca por palavras em id, tag, caminho e resumo", () => {
		expect(searchApiOperations(spec.operations, "listar produtos")[0]!.id).toBe("getProdutos");
		expect(searchApiOperations(spec.operations, "pedido venda").length).toBeGreaterThan(1);
	});
});

describe("buildApiRequestUrl", () => {
	const spec = parseOk(oas3);
	const one = spec.operations.find((op) => op.path.endsWith("{idPedidoVenda}") && op.method === "GET")!;
	const list = spec.operations.find((op) => op.id === "getPedidosVendas")!;
	const base = spec.baseUrl;

	it("codifica parâmetros de caminho e monta a query", () => {
		expect(buildApiRequestUrl(base, one, { idPedidoVenda: "12/../3?x#y" }).url.toString()).toBe(
			"https://api.exemplo.com.br/Api/v3/pedidos/vendas/12%2F..%2F3%3Fx%23y",
		);
		expect(buildApiRequestUrl(base, list, { pagina: 2, situacao: "aberto" }).url.search).toBe("?pagina=2&situacao=aberto");
	});

	it.each([[".."], ["."], [""]])("recusa caminho %j", (value) => {
		expect(() => buildApiRequestUrl(base, one, { idPedidoVenda: value })).toThrow();
	});

	it("recusa parâmetro não declarado (inclui tentativa de host/url), enum inválido e falta de obrigatório", () => {
		expect(() => buildApiRequestUrl(base, list, { host: "evil.com" })).toThrow(/desconhecido/);
		expect(() => buildApiRequestUrl(base, list, { url: "https://evil.com" })).toThrow(/desconhecido/);
		expect(() => buildApiRequestUrl(base, list, { situacao: "x" })).toThrow(/use um de/);
		expect(() => buildApiRequestUrl(base, one, {})).toThrow(/Falta/);
	});

	it("nunca sai da base mesmo com template malicioso no catálogo", () => {
		const evil: ApiOperation = { ...one, path: "/../../outra" };
		expect(() => buildApiRequestUrl(base, evil, { idPedidoVenda: "1" })).toThrow(/fora da API/);
	});
});

describe("URL do usuário", () => {
	it("extrai e compara URLs ignorando barra final, fragmento e caixa do host", () => {
		const text = "conecta nessa API: https://Developer.Exemplo.com.br/openapi.json#x, valeu";
		expect(extractUrls(text)).toEqual(["https://Developer.Exemplo.com.br/openapi.json#x"]);
		expect(urlInUserText("https://developer.exemplo.com.br/openapi.json", text)).toBe(true);
		expect(urlInUserText("https://developer.exemplo.com.br/outra", text)).toBe(false);
		expect(urlInUserText("nao é url", text)).toBe(false);
	});
	it("slug do nome", () => {
		expect(slugifyApiName("Bling ERP!")).toBe("bling-erp");
		expect(slugifyApiName("???")).toBe("api");
	});
});

describe("card persistido", () => {
	const proposal = { specUrl: SPEC_URL, name: "Exemplo", domain: "api.exemplo.com.br", baseUrl: "https://api.exemplo.com.br/Api/v3", authKind: "oauth2", operationCount: 5, readCount: 3, groups: [{ tag: "Produtos", total: 1, read: 1, write: 0 }], redirectUrl: "https://atlas.example/v1/mcp/oauth/callback" };
	it("valida a proposta e o connector kind api", () => {
		expect(parseApiProposal(proposal)).toMatchObject({ name: "Exemplo", authKind: "oauth2" });
		expect(parseApiProposal({ ...proposal, authKind: "x" })).toBeNull();
		expect(parseApiProposal({ ...proposal, baseUrl: "javascript:1" })).toBeNull();
		expect(parseLoginConnector({ kind: "api", id: "exemplo", name: "Exemplo", api: proposal })?.api?.domain).toBe("api.exemplo.com.br");
		expect(parseLoginConnector({ kind: "api", id: "exemplo", name: "Exemplo" })).toBeNull();
	});
});

describe("confirmação curta e proposta do bot", () => {
	it("aceita 'conecta pra mim' e afins; recusa pergunta, link ou texto longo", () => {
		for (const ok of ["Conecta pra mim", "pode conectar", "Sim", "isso!", "Pode ser"]) expect(isShortConnectConfirmation(ok), ok).toBe(true);
		for (const no of ["o que é isso?", "conecta https://a.test/x.json", "", "tenho dúvida sobre a conta", "x".repeat(80)]) expect(isShortConnectConfirmation(no), no).toBe(false);
	});

	it("foundByBot sobrevive ao parse da proposta", () => {
		const base = { specUrl: "https://d.test/o.json", baseUrl: "https://api.d.test/v1", name: "D", domain: "api.d.test", authKind: "none", groups: [] };
		expect(parseApiProposal({ ...base, foundByBot: true })?.foundByBot).toBe(true);
		expect(parseApiProposal(base)?.foundByBot).toBeUndefined();
	});
});

describe("especificação real do Bling (recorte)", () => {
	const raw = JSON.parse(readFileSync(new URL("./fixtures/bling-openapi.trimmed.json", import.meta.url), "utf8"));
	const parsed = parseOpenApiDocument(raw, { specUrl: "https://developer.bling.com.br/build/assets/openapi-Dw6cY8yQ.json" });

	it("usa o servidor de produção e o login de produção, nunca o ambiente de testes da documentação", () => {
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.spec.baseUrl).toBe("https://api.bling.com.br/Api/v3");
		expect(parsed.spec.auth.kind).toBe("oauth2");
		expect(parsed.spec.auth.tokenUrl).toBe("https://bling.com.br/Api/v3/oauth/token");
		expect(parsed.spec.auth.authorizeUrl).toBe("https://bling.com.br/Api/v3/oauth/authorize");
	});

	it("tags viram grupos legíveis e as operações de leitura têm parâmetros", () => {
		if (!parsed.ok) throw new Error(parsed.error);
		const groups = summarizeApiGroups(parsed.spec.operations);
		expect(groups.length).toBeGreaterThan(3);
		expect(readableApiTags(parsed.spec.operations)).toEqual(expect.arrayContaining(["Contatos", "Produtos"]));
		const gets = parsed.spec.operations.filter((op) => op.method === "GET");
		expect(gets.length).toBeGreaterThan(0);
		expect(gets.some((op) => op.params.length > 0)).toBe(true);
	});

	it("a ordem dos esquemas e dos servidores não muda a escolha", () => {
		const flipped = { ...raw, servers: [...raw.servers].reverse(), security: [{ "OAuth2-Docs": [], OAuth2: [] }], components: { securitySchemes: { "OAuth2-Docs": raw.components.securitySchemes["OAuth2-Docs"], OAuth2: raw.components.securitySchemes.OAuth2 } } };
		const result = parseOpenApiDocument(flipped, { specUrl: "https://developer.bling.com.br/o.json" });
		if (!result.ok) throw new Error(result.error);
		expect(result.spec.baseUrl).toBe("https://api.bling.com.br/Api/v3");
		expect(result.spec.auth.tokenUrl).toBe("https://bling.com.br/Api/v3/oauth/token");
	});
});

describe("API_AUTH_LABEL", () => {
	it("rótulos em pt-BR simples, sem sigla nem termo técnico, um por tipo", () => {
		expect(API_AUTH_LABEL).toEqual({ oauth2: "Entrar com a conta", apiKey: "Chave de acesso", bearer: "Código de acesso", none: "Sem login" });
		for (const label of Object.values(API_AUTH_LABEL)) expect(label).not.toMatch(/OAuth|API|token|autentica/i);
	});
});
