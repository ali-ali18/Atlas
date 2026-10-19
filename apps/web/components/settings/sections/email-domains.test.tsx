import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EmailDomainDto } from "@workspace/shared";
import { DomainChoice } from "@/components/ui/templates/template-4/chat-context-panel/bot-email-tab";
import { EmailDomainsPanel, domainStatusLabel } from "./email-domains";

Object.assign(globalThis, { React });

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = async () => true;
const pending: EmailDomainDto = {
	id: "d1",
	domain: "suaempresa.com.br",
	status: "pending",
	verified: false,
	records: [
		{ type: "MX", name: "suaempresa.com.br", value: "inbound-smtp.example.com", priority: 10, valid: false },
		{ type: "TXT", name: "omail._domainkey.suaempresa.com.br", value: "v=DKIM1; k=rsa; p=abc", priority: null, valid: true },
	],
};
const verified: EmailDomainDto = { ...pending, id: "d2", domain: "outra.com.br", status: "verified", verified: true, records: [] };

test("rótulos de estado do domínio", () => {
	assert.equal(domainStatusLabel(pending), "Pendente");
	assert.equal(domainStatusLabel(verified), "Verificado");
	assert.equal(domainStatusLabel({ status: "failed", verified: false }), "Falhou");
	assert.equal(domainStatusLabel({ status: "under_review", verified: false }), "Em análise");
});

test("pendente: tabela de DNS (tipo/nome/valor) com copiar, selo Pendente e botão Verificar", () => {
	const out = html(<EmailDomainsPanel busyId={null} domains={[pending]} onAdd={noop} onRemove={() => {}} onVerify={() => {}} />);
	assert.match(out, /data-email-domain="suaempresa.com.br"/);
	assert.match(out, />Pendente</);
	assert.match(out, />Verificar</);
	assert.match(out, /data-dns-record="MX"/);
	assert.match(out, /data-dns-record="TXT"/);
	assert.match(out, />Tipo</);
	assert.match(out, />Nome</);
	assert.match(out, />Valor</);
	assert.equal((out.match(/aria-label="Copiar (nome|valor)"/g) ?? []).length, 4);
	assert.match(out, /aria-label="Remover suaempresa.com.br"/);
	assert.match(out, /plano pago do OpenMail/);
	assert.doesNotMatch(out, /R\$/);
});

test("verificado: sem tabela nem botão Verificar; adicionar domínio sempre disponível", () => {
	const out = html(<EmailDomainsPanel busyId={null} domains={[verified]} onAdd={noop} onRemove={() => {}} onVerify={() => {}} />);
	assert.match(out, />Verificado</);
	assert.doesNotMatch(out, /data-testid="dns-records"/);
	assert.doesNotMatch(out, />Verificar</);
	assert.match(out, /aria-label="Adicionar domínio"/);
});

test("seletor de domínio da caixa nova: padrão do provedor + domínios verificados", () => {
	const out = html(<DomainChoice domains={["suaempresa.com.br"]} onChange={() => {}} value="__default" />);
	assert.match(out, /Domínio do endereço/);
	assert.match(out, /data-testid="email-domain-choice"/);
});
