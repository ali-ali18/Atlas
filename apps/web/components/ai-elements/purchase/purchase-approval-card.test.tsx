import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalRequestEvent } from "@workspace/shared";
import { I18nProvider } from "@/lib/i18n/provider";
import { PurchaseApprovalCardView } from "./purchase-approval-card";
import { payments as ptBR } from "@/lib/i18n/messages/pt-BR/payments";
import { AtlasApiError } from "@/lib/atlas-api";
import { formatMoney, purchaseRequestFromEvent, purchaseSendErrorKey } from "./purchase-facts";

Object.assign(globalThis, { React });

const event = (over: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent => ({
	type: "approval_request",
	requestId: "req-1",
	callId: "c1",
	toolName: "checkout",
	effect: "money",
	args: {},
	riskFacts: { amount: 109.8, currency: "BRL", merchant: "loja.test", shipping: 10, card: "Visa final 1111", items: ["2× Camiseta azul · R$ 49,90"], irreversible: true },
	ownerInput: "card_cvv",
	runId: "run-1",
	...over,
});

test("fatos do cartão de compra saem do evento; sem campo de CVV ou sem run não é compra", () => {
	const r = purchaseRequestFromEvent(event());
	assert.ok(r);
	assert.deepEqual(r.facts, { store: "loja.test", items: ["2× Camiseta azul · R$ 49,90"], amount: 109.8, currency: "BRL", shipping: 10, card: "Visa final 1111" });
	assert.equal(r.inputOnly, false);
	assert.equal(purchaseRequestFromEvent(event({ ownerInput: undefined })), null);
	assert.equal(purchaseRequestFromEvent(event({ runId: undefined })), null);
	assert.equal(purchaseRequestFromEvent(event({ riskFacts: { currency: "BRL" } })), null);
	assert.equal(purchaseRequestFromEvent(event({ inputOnly: true }))?.inputOnly, true);
});

test("dinheiro formatado por idioma", () => {
	assert.match(formatMoney(109.8, "BRL", "pt-BR"), /R\$\s?109,80/);
	assert.match(formatMoney(109.8, "USD", "en-US"), /\$109\.80/);
});

const facts = purchaseRequestFromEvent(event())!.facts;
const render = (props: Partial<React.ComponentProps<typeof PurchaseApprovalCardView>> = {}) =>
	renderToStaticMarkup(
		<I18nProvider locale="pt-BR">
			<PurchaseApprovalCardView facts={facts} onApprove={() => {}} onDismiss={() => {}} {...props} />
		</I18nProvider>,
	);

test("cartão de compra mostra loja, itens, frete, total e final do cartão, com o campo de CVV seguro", () => {
	const html = render();
	for (const text of ["Confirmar compra", "loja.test", "Camiseta azul", "Frete", "Total", "Visa final 1111", "Código de segurança (CVV)", "Agora não", "Precisa de você"]) assert.ok(html.includes(text), text);
	assert.match(html, /R\$\s?109,80/);
	assert.match(html, /autoComplete="cc-csc"/);
	assert.match(html, /inputMode="numeric"/);
	assert.match(html, /type="password"/);
	assert.doesNotMatch(html, /\svalue=/);
});

test("com mandato o cartão só pede o código: sem 'confirmar', só o campo e o envio", () => {
	const html = render({ inputOnly: true });
	assert.match(html, /Digite o código do cartão/);
	assert.match(html, /Sua autorização cobre esta compra/);
	assert.match(html, /Enviar código e pagar/);
	assert.doesNotMatch(html, /Confirmar compra/);
});

test("aprovado: sem campo de CVV, selo e nota; dispensado e vencido também", () => {
	const approved = render({ status: "approved" });
	assert.doesNotMatch(approved, /data-slot="cvv-field"/);
	assert.match(approved, /Aprovada/);
	assert.match(approved, /Código enviado/);
	assert.match(render({ status: "dismissed" }), /Nada foi cobrado/);
	assert.match(render({ status: "expired" }), /Peça de novo ao bot/);
});

test("erro de envio aparece no cartão", () => {
	assert.match(render({ error: "Não consegui enviar. Tente de novo." }), /Não consegui enviar/);
});

test("erro ao enviar: 400 cvv_required pede o código (mensagem do campo), 503 é indisponível, o resto é genérico", () => {
	assert.equal(purchaseSendErrorKey(new AtlasApiError("cvv_required", 400, { error: "cvv_required" })), "payments.purchase.cvvInvalid");
	assert.equal(purchaseSendErrorKey(new AtlasApiError("Bad request", 400, { error: "cvv_required" })), "payments.purchase.cvvInvalid");
	assert.equal(purchaseSendErrorKey(new AtlasApiError("cvv_not_accepted", 400, { error: "cvv_not_accepted" })), "payments.purchase.errorSend");
	assert.equal(purchaseSendErrorKey(new AtlasApiError("payment_unavailable", 503)), "payments.purchase.errorUnavailable");
	assert.equal(purchaseSendErrorKey(new Error("rede")), "payments.purchase.errorSend");
	assert.match(ptBR[purchaseSendErrorKey(new AtlasApiError("cvv_required", 400))], /Digite os 3 ou 4 números do código/);
});
