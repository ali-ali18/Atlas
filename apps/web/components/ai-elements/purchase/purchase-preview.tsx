"use client";

import { PurchaseApprovalCard } from "./purchase-approval-card";
import type { PurchaseRequest } from "./purchase-facts";

const FACTS = { store: "lojadecafe.com.br", items: ["2× Café em grãos 500 g · R$ 42,90", "1× Moedor manual · R$ 119,00"], amount: 214.8, currency: "BRL", shipping: 10, card: "Visa final 1111" };

const BASE: PurchaseRequest = { requestId: "req-compra-1", runId: "run-compra-1", inputOnly: false, facts: FACTS };

/** Prévia: o cartão de compra nos estados que o dono vê. Só montado pela página de prévia (ver `app/dev/compras`). */
export function PurchasePreview() {
	return (
		<main className="mx-auto flex max-w-xl flex-col gap-4 bg-background p-4" data-purchase-preview>
			<section data-preview-block="pending">
				<PurchaseApprovalCard request={BASE} />
			</section>
			<section data-preview-block="mandate">
				<PurchaseApprovalCard request={{ ...BASE, requestId: "req-compra-2", inputOnly: true }} />
			</section>
			<section data-preview-block="approved">
				<PurchaseApprovalCard initialStatus="approved" request={{ ...BASE, requestId: "req-compra-3" }} />
			</section>
		</main>
	);
}
