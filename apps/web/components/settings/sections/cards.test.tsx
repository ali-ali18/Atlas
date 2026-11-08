import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/provider";
import { emptyCardForm } from "../cards-state";
import { CardFormView, CardsListView } from "./cards";

Object.assign(globalThis, { React });

const noop = () => {};
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="pt-BR">{node}</I18nProvider>);
const cards = [
	{ id: "c1", label: "Visa final 1111", brand: "visa" as const, last4: "1111", createdAt: "2026-11-07T10:00:00Z" },
	{ id: "c2", label: "Cartão do trabalho", brand: "mastercard" as const, last4: "4444", createdAt: "2026-11-07T11:00:00Z" },
];

test("lista mostra apelido, bandeira e final, e a lixeira com nome acessível", () => {
	const html = wrap(<CardsListView cards={cards} configured onAdd={noop} onDelete={noop} />);
	assert.match(html, /Cartão do trabalho/);
	assert.match(html, /Mastercard final 4444/);
	assert.match(html, /aria-label="Apagar cartão Visa final 1111"/);
	assert.match(html, /nunca é guardado/);
	assert.match(html, /Adicionar cartão/);
});

test("cartão sem apelido não repete a linha de bandeira e final", () => {
	const html = wrap(<CardsListView cards={[cards[0]!]} configured onAdd={noop} onDelete={noop} />);
	assert.equal(html.split(">Visa final 1111<").length - 1, 1);
});

test("vazio e cofre indisponível", () => {
	assert.match(wrap(<CardsListView cards={[]} configured onAdd={noop} onDelete={noop} />), /Nenhum cartão salvo/);
	const off = wrap(<CardsListView cards={[]} configured={false} onAdd={noop} onDelete={noop} />);
	assert.match(off, /Os cartões ainda não estão disponíveis neste servidor/);
	assert.doesNotMatch(off, /CONNECTOR_ENCRYPTION_KEY|criptografia/);
	assert.match(off, /disabled/);
});

test("formulário não tem campo de CVV (de propósito) e anuncia os erros", () => {
	const html = wrap(<CardFormView errors={{ number: "payments.cards.errorNumber", expiry: "payments.cards.errorExpiry" }} form={emptyCardForm()} onCancel={noop} onChange={noop} onSave={noop} saveError={null} saving={false} />);
	assert.doesNotMatch(html, /cvv|cvc|segurança/i);
	assert.match(html, /autoComplete="cc-number"/);
	assert.match(html, /Confira o número do cartão/);
	assert.match(html, /Validade vencida/);
	assert.match(html, /Endereço de cobrança/);
});
