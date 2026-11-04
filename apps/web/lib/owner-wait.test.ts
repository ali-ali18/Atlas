import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_WAIT_CARD_DETAIL } from "@workspace/shared";
import { loadMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translator";
import { loginOutcomeBadge, ownerConfirmClosedLabel, ownerWaitDeadlineText, parseApprovalDetails, returnMarkerText } from "./owner-wait";

const pt = createTranslator("pt-BR");
const tz = { timeZone: "America/Sao_Paulo" };
const now = new Date("2026-11-04T12:00:00.000Z"); // 09:00 em São Paulo

test("prazo em frase: mesmo dia só a hora, outro dia com a data; inválido = nada", () => {
	assert.equal(ownerWaitDeadlineText("2026-11-04T17:30:00.000Z", now, pt, tz), "Sigo sem isso às 14:30");
	assert.equal(ownerWaitDeadlineText("2026-11-05T17:30:00.000Z", now, pt, tz), "Sigo sem isso em 05/11 às 14:30");
	assert.equal(ownerWaitDeadlineText(undefined, now, pt, tz), null);
	assert.equal(ownerWaitDeadlineText("amanhã", now, pt, tz), null);
});

test("Volto às: no idioma da tela, e o outro dia leva a data", async () => {
	assert.equal(returnMarkerText("2026-11-04T17:30:00.000Z", now, pt, tz), "Volto às 14:30");
	assert.equal(returnMarkerText("2026-11-06T13:05:00.000Z", now, pt, tz), "Volto em 06/11 às 10:05");
	assert.match(returnMarkerText("2026-11-04T17:30:00.000Z", now, createTranslator("en-US", await loadMessages("en-US")), tz), /^Back at 2:30\sPM$/);
});

test("selo do login: cada saída tem rótulo e tom; sem saída (v1/v2) = Feito", () => {
	assert.deepEqual(loginOutcomeBadge("takeover", pt).label, "Você assumiu");
	assert.equal(loginOutcomeBadge("takeover", pt).tone, "info");
	assert.equal(loginOutcomeBadge("skipped_timeout", pt).label, "Tempo esgotado · segui sem isso");
	assert.equal(loginOutcomeBadge("ignored", pt).label, "Dispensado");
	assert.equal(loginOutcomeBadge("skipped", pt).label, "Pulado · segui sem isso");
	assert.equal(loginOutcomeBadge(undefined, pt).label, "Feito");
});

test("como o cartão genérico fechou: prazo, ignorado e rascunho descartado; o resto não muda o marcador", () => {
	assert.equal(ownerConfirmClosedLabel(OWNER_WAIT_CARD_DETAIL.skipped_timeout, pt), "Tempo esgotado · segui sem isso");
	assert.equal(ownerConfirmClosedLabel(OWNER_WAIT_CARD_DETAIL.ignored, pt), "Dispensado");
	assert.equal(ownerConfirmClosedLabel("Descartado", pt), "Descartado");
	assert.equal(ownerConfirmClosedLabel("Agora não", pt), null);
	assert.equal(ownerConfirmClosedLabel(undefined, pt), null);
});

test("args legíveis: campos comuns traduzidos, desconhecido humanizado, valor com quebra continua, nota do rascunho separada", () => {
	const draft = parseApprovalDetails("Resumo de outubro para a Ana.\n\nto: ana@cliente.com\nsubject: Vendas\nbody: Oi Ana,\nsegue o resumo.\nreplyToId: m-1", true, pt);
	assert.equal(draft.note, "Resumo de outubro para a Ana.");
	assert.deepEqual(draft.fields.map((field) => [field.label, field.value]), [
		["Para", "ana@cliente.com"],
		["Assunto", "Vendas"],
		["Mensagem", "Oi Ana,\nsegue o resumo."],
		["Reply to id", "m-1"],
	]);
	assert.deepEqual(parseApprovalDetails("(sem argumentos)", false, pt).fields, []);
	assert.deepEqual(parseApprovalDetails(undefined, false, pt), { fields: [] });
	assert.deepEqual(parseApprovalDetails("pageId: p1", false, pt).fields, [{ key: "pageId", label: "Page id", value: "p1" }]);
});
