import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { McpToolsetConnection } from "./mcp/registry.js";
import type { McpCallResult } from "./mcp/call.js";

/**
 * Conector falso e neutro (`erp`) da suíte de regressão do harness. Dados inventados, sem relação com nenhum
 * sistema ou cliente real. Usado pelo teste determinístico (`harness-regression.test.ts`) e pelo eval opt-in
 * (`evals/harness/live-eval.ts`). Fora do build (`*.fixtures.ts`).
 */

export const CUSTOMER_ID = "cus_7f3a91";
export const SKU_A = "SKU-100";
export const SKU_B = "SKU-200";
export const PAYMENT_30D = "pm_30d";
export const PAYMENT_CASH = "pm_cash";
export const ORDER_ID = "ord_55021";

const readOnly = { readOnlyHint: true } as const;

export const ERP_CONNECTION: McpToolsetConnection = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{
			name: "find_customer",
			description: "Find a customer by name",
			inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
			annotations: readOnly,
		},
		{
			name: "list_items",
			description: "List sellable items with their prices",
			inputSchema: { type: "object", properties: { query: { type: "string" } } },
			annotations: readOnly,
		},
		{
			name: "list_payment_methods",
			description: "List the payment methods accepted for orders",
			inputSchema: { type: "object", properties: {} },
			annotations: readOnly,
		},
		{
			name: "create_order",
			description: "Create a sales order for a customer",
			inputSchema: {
				type: "object",
				required: ["customer_id", "items", "payment_method_id", "due_days"],
				properties: {
					customer_id: { type: "string" },
					items: {
						type: "array",
						items: {
							type: "object",
							required: ["sku", "qty", "price"],
							properties: { sku: { type: "string" }, qty: { type: "integer" }, price: { type: "number" } },
						},
					},
					payment_method_id: { type: "string", enum: [PAYMENT_30D, PAYMENT_CASH] },
					due_days: { type: "integer" },
				},
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
	],
};

export const EXPOSED = {
	findCustomer: "mcp__erp__find_customer",
	listItems: "mcp__erp__list_items",
	listPaymentMethods: "mcp__erp__list_payment_methods",
	createOrder: "mcp__erp__create_order",
} as const;

export const COMPLETE_ORDER_ARGS = {
	customer_id: CUSTOMER_ID,
	items: [{ sku: SKU_A, qty: 2, price: 25.5 }],
	payment_method_id: PAYMENT_30D,
	due_days: 30,
};

export const ERP_REJECTION = "ERP 422: payment_method_id not accepted for this customer's credit profile";

export type FakeErp = {
	call: (exposedName: string, args: Record<string, unknown>) => Promise<McpCallResult>;
	/** Toda chamada que chegou ao "ERP" (leitura ou escrita), na ordem. */
	calls: Array<{ name: string; args: Record<string, unknown> }>;
};

/**
 * Backend do conector falso. `createOrderFails` faz o ERP recusar a escrita mesmo com os argumentos completos
 * (o caso "aprovado e falhou"); o ERP também recusa de verdade campo obrigatório ausente.
 */
export function fakeErp(options: { createOrderFails?: boolean } = {}): FakeErp {
	const calls: FakeErp["calls"] = [];
	const ok = (value: unknown): McpCallResult => ({ ok: true, text: JSON.stringify(value), truncated: false });
	const fail = (text: string): McpCallResult => ({ ok: false, text, truncated: false });
	return {
		calls,
		call: async (name, args) => {
			calls.push({ name, args });
			switch (name) {
				case EXPOSED.findCustomer:
					return ok({ customers: [{ id: CUSTOMER_ID, name: "Cliente Exemplo" }] });
				case EXPOSED.listItems:
					return ok({ items: [{ sku: SKU_A, name: "Item A", price: 25.5 }, { sku: SKU_B, name: "Item B", price: 40 }] });
				case EXPOSED.listPaymentMethods:
					return ok({ methods: [{ id: PAYMENT_30D, name: "Boleto 30 dias" }, { id: PAYMENT_CASH, name: "A vista" }] });
				case EXPOSED.createOrder: {
					const missing = ["customer_id", "items", "payment_method_id", "due_days"].filter((key) => args[key] === undefined || args[key] === "");
					if (missing.length > 0) return fail(`ERP 422: missing required field(s): ${missing.join(", ")}`);
					return options.createOrderFails ? fail(ERP_REJECTION) : ok({ order_id: ORDER_ID });
				}
				default:
					return fail(`unknown tool ${name}`);
			}
		},
	};
}

export const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
export const assistantCalls = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
	finishReason: "tool_calls",
});
export const assistantSays = (content: string): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content },
	finishReason: "stop",
});
