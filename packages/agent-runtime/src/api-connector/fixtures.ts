/**
 * Fixtures dos testes do conector de API. `blingLikeSpec` é escrita à mão no
 * formato da API v3 do Bling (base api.bling.com.br/Api/v3, OAuth2 com
 * authorization code, tags por módulo); não é cópia da especificação oficial.
 * Nenhum teste fala com a rede real.
 */

export const SPEC_URL = "https://developer.bling.test/openapi.json";
export const BASE_URL = "https://api.bling.test/Api/v3";

export const blingLikeSpec = {
	openapi: "3.0.0",
	info: { title: "Bling API", description: "ERP de teste" },
	servers: [{ url: BASE_URL }],
	security: [{ OAuth2: [] }],
	components: {
		securitySchemes: {
			OAuth2: {
				type: "oauth2",
				flows: {
					authorizationCode: {
						authorizationUrl: "https://www.bling.test/Api/v3/oauth/authorize",
						tokenUrl: "https://www.bling.test/Api/v3/oauth/token",
						scopes: {},
					},
				},
			},
		},
	},
	paths: {
		"/pedidos/vendas": {
			get: {
				operationId: "getPedidosVendas",
				tags: ["Pedidos - Vendas"],
				summary: "Obtém uma lista de pedidos de venda",
				parameters: [
					{ name: "pagina", in: "query", schema: { type: "integer" } },
					{ name: "limite", in: "query", schema: { type: "integer" } },
					{ name: "idsSituacoes[]", in: "query", schema: { type: "array" } },
				],
			},
			post: { operationId: "postPedidosVendas", tags: ["Pedidos - Vendas"], summary: "Cria um pedido de venda", requestBody: {} },
		},
		"/pedidos/vendas/{idPedidoVenda}": {
			get: {
				operationId: "getPedidosVendasId",
				tags: ["Pedidos - Vendas"],
				summary: "Obtém um pedido de venda",
				parameters: [{ name: "idPedidoVenda", in: "path", required: true, schema: { type: "integer" } }],
			},
			delete: { operationId: "deletePedidosVendasId", tags: ["Pedidos - Vendas"], summary: "Exclui um pedido de venda", parameters: [{ name: "idPedidoVenda", in: "path", required: true, schema: { type: "integer" } }] },
		},
		"/produtos": { get: { operationId: "getProdutos", tags: ["Produtos"], summary: "Obtém uma lista de produtos", parameters: [{ name: "pagina", in: "query", schema: { type: "integer" } }] } },
		"/contatos": { get: { operationId: "getContatos", tags: ["Contatos"], summary: "Obtém uma lista de contatos" } },
	},
};

export const apiKeySpecYaml = `openapi: 3.0.1
info:
  title: Loja YAML
servers:
  - url: https://api.loja.test/v2
components:
  securitySchemes:
    KeyAuth:
      type: apiKey
      in: query
      name: api_key
security:
  - KeyAuth: []
paths:
  /itens:
    get:
      operationId: listItens
      tags: [Itens]
      summary: Lista itens
`;

export const swagger2Spec = {
	swagger: "2.0",
	info: { title: "Legado" },
	host: "api.legado.test",
	basePath: "/v1",
	schemes: ["https"],
	securityDefinitions: { token: { type: "apiKey", in: "header", name: "X-Token" } },
	paths: { "/clientes/{id}": { get: { operationId: "getCliente", tags: ["Clientes"], parameters: [{ name: "id", in: "path", required: true, type: "string" }] } } },
};

/** Resposta mínima `Response` para o fetch injetado. */
export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

/** DNS falso: tudo público, salvo o que o teste marcar. */
export const publicLookup = async (hostname: string): Promise<string[]> => (/^(10\.|127\.|192\.168\.)/.test(hostname) ? [hostname] : hostname.startsWith("internal") ? ["10.0.0.7"] : ["93.184.216.34"]);
