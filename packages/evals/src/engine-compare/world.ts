/**
 * Mundo falso do comparativo v1×v2: fornecedores, lojas e concorrentes inventados (nada real), com preços fixos.
 * Toda busca/leitura responde com dados daqui, então o resultado de um run depende só do motor e do roteiro.
 */

export const SUPPLIERS = [
	{ name: "Ervas do Vale", host: "ervasdovale.example.com", price: 18.9, minOrder: 5 },
	{ name: "Raízes & Folhas", host: "raizesefolhas.example.com", price: 21.5, minOrder: 10 },
	{ name: "Natureza Viva Atacado", host: "naturezaviva.example.com", price: 17.2, minOrder: 20 },
	{ name: "Herbário Central", host: "herbariocentral.example.com", price: 24.0, minOrder: 5 },
	{ name: "Campo Verde Ervas", host: "campoverde.example.com", price: 19.75, minOrder: 8 },
] as const;

export const STORES = [
	{ name: "Loja Sol", host: "lojasol.example.com", price: 129.9 },
	{ name: "Mercado Azul", host: "mercadoazul.example.com", price: 119.0 },
	{ name: "Casa Prima", host: "casaprima.example.com", price: 134.5 },
] as const;

export const COMPETITORS = [
	{ name: "Alfa Chás", host: "alfachas.example.com", focus: "chás premium em sachê" },
	{ name: "Beta Naturais", host: "betanaturais.example.com", focus: "granel e kits de presente" },
	{ name: "Gama Ervas", host: "gamaervas.example.com", focus: "assinatura mensal" },
	{ name: "Delta Bem-Estar", host: "deltabemestar.example.com", focus: "lojas físicas em shoppings" },
] as const;

export const SKUS = [
	{ sku: "CAM-100", name: "Camomila 100 g", price: 12.4 },
	{ sku: "CAM-250", name: "Camomila 250 g", price: 27.9 },
	{ sku: "HRT-100", name: "Hortelã 100 g", price: 10.8 },
	{ sku: "BOL-100", name: "Boldo 100 g", price: 14.3 },
	{ sku: "ERV-100", name: "Erva-doce 100 g", price: 9.9 },
	{ sku: "CID-100", name: "Capim-cidreira 100 g", price: 11.6 },
] as const;

export const brl = (value: number) => `R$ ${value.toFixed(2).replace(".", ",")}`;

/** Texto de página/busca determinístico: o conteúdo cita o nome e o preço, para a cobertura ser conferida no texto final. */
export const supplierPage = (s: (typeof SUPPLIERS)[number]) =>
	`${s.name} (${s.host}): erva seca a granel, ${brl(s.price)} por kg, pedido mínimo de ${s.minOrder} kg, entrega em 5 dias úteis.`;
export const storePage = (s: (typeof STORES)[number]) => `${s.name} (${s.host}): Kit Chá Premium 12 sabores por ${brl(s.price)}, frete grátis acima de R$ 150.`;
export const competitorPage = (c: (typeof COMPETITORS)[number]) => `${c.name} (${c.host}): foco em ${c.focus}; ticket médio declarado de R$ 60 a R$ 90.`;
export const skuPage = (s: (typeof SKUS)[number]) => `SKU ${s.sku} - ${s.name}: ${brl(s.price)} por unidade, estoque disponível.`;
