import assert from "node:assert/strict";
import test from "node:test";
import type { PageSpec } from "@workspace/shared";

import { barPercent, formatPageDelta, formatPageNumber, formatPageValue, reconcilePageSnapshot, resolveTab, sourceCountLabel } from "./page-format";

const nbsp = (text: string) => text.replace(/\s/g, " ");

const spec = (title: string): PageSpec => ({ v: 1, title, blocks: [{ id: "h", type: "heading", text: title }] });

test("formatPageNumber: moeda, percentual, compacto e sufixo em pt-BR", () => {
	assert.equal(nbsp(formatPageNumber(1234.5, { unit: "BRL" })), "R$ 1.234,50");
	assert.equal(nbsp(formatPageNumber(120000, { unit: "brl", format: "compact" })), "R$ 120 mil");
	assert.equal(formatPageNumber(12.5, { format: "percent" }), "12,5%");
	assert.equal(formatPageNumber(7, { unit: "%" }), "7%");
	assert.equal(formatPageNumber(3.14159, { unit: "kg" }), "3,14 kg");
	assert.equal(nbsp(formatPageNumber(1500000, { format: "compact" })), "1,5 mi");
});

test("formatPageValue: texto passa como veio, vazio vira traço", () => {
	assert.equal(formatPageValue("Alta"), "Alta");
	assert.equal(formatPageValue(null), "—");
	assert.equal(formatPageValue(""), "—");
	assert.equal(formatPageValue(10), "10");
});

test("formatPageDelta: seta e sinal carregam a direção", () => {
	assert.equal(formatPageDelta({ value: 8, direction: "up", label: "vs meta" }), "▲ 8% vs meta");
	assert.equal(formatPageDelta({ value: -3.5, direction: "down" }), "▼ 3,5%");
	assert.equal(formatPageDelta({ value: "estável", direction: "flat" }), "▬ estável");
});

test("barPercent: relativo ao maior, sem negativo nem divisão por zero", () => {
	assert.equal(barPercent(50, 100), 50);
	assert.equal(barPercent(100, 100), 100);
	assert.equal(barPercent(-5, 100), 0);
	assert.equal(barPercent(5, 0), 0);
});

test("sourceCountLabel e resolveTab", () => {
	assert.equal(sourceCountLabel(0), null);
	assert.equal(sourceCountLabel(1), "1 fonte");
	assert.equal(sourceCountLabel(3), "3 fontes");
	const tabs = [{ id: "a" }, { id: "b" }];
	assert.equal(resolveTab(tabs, "b").id, "b");
	assert.equal(resolveTab(tabs, "zzz").id, "a");
	assert.equal(resolveTab(tabs, null).id, "a");
});

test("reconcilePageSnapshot: o servidor vale só se for mais novo ou igual; apagada marca removed", () => {
	const card = { revision: 2, spec: spec("snap"), sourceCount: 1 };
	const remote = (revision: number) => ({ spec: spec(`srv${revision}`), revision, sources: [{ title: "a" }, { title: "b" }], updatedAt: "2026-10-22T10:00:00Z" });
	assert.equal(reconcilePageSnapshot(card, null)?.spec.title, "snap");
	assert.equal(reconcilePageSnapshot(card, remote(3))?.spec.title, "srv3");
	assert.equal(reconcilePageSnapshot(card, remote(3))?.sourceCount, 2);
	assert.equal(reconcilePageSnapshot(card, remote(2))?.spec.title, "srv2");
	// Evento ao vivo mais novo que a leitura: fica o cartão.
	const stale = reconcilePageSnapshot(card, remote(1));
	assert.equal(stale?.spec.title, "snap");
	assert.equal(stale?.updatedAt, null);
	assert.equal(reconcilePageSnapshot(card, "missing")?.removed, true);
	// Sem snapshot (cartão antigo sem spec): espera o servidor.
	assert.equal(reconcilePageSnapshot({ revision: 1, sourceCount: 0 }, null), null);
	assert.equal(reconcilePageSnapshot({ revision: 1, sourceCount: 0 }, remote(1))?.spec.title, "srv1");
});
