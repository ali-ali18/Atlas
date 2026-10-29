import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTimeSeparators,
	formatSeparatorLabel,
	needsSeparator,
} from "./chat-time-separators";

const TZ = "America/Sao_Paulo"; // UTC-3, sem DST em 2025+
const at = (iso: string) => new Date(iso);
// 13/10/2026 (terça) 18:30 local = 21:30Z
const NOW = at("2026-10-13T21:30:00Z");

test("hoje: só hora", () => {
	assert.equal(formatSeparatorLabel(at("2026-10-13T21:13:00Z"), NOW, TZ), "18:13");
});

test("ontem", () => {
	assert.equal(formatSeparatorLabel(at("2026-10-12T21:13:00Z"), NOW, TZ), "ontem, 18:13");
});

test("esta semana: dia da semana + data", () => {
	// 09/10/2026 é sexta
	assert.equal(
		formatSeparatorLabel(at("2026-10-09T21:13:00Z"), NOW, TZ),
		"sex., 9 de out. 18:13",
	);
});

test("mais antigo no mesmo ano: sem dia da semana", () => {
	assert.equal(formatSeparatorLabel(at("2026-03-05T15:00:00Z"), NOW, TZ), "5 de mar. 12:00");
});

test("ano diferente inclui o ano", () => {
	assert.equal(
		formatSeparatorLabel(at("2025-10-09T21:13:00Z"), NOW, TZ),
		"9 de out. de 2025, 18:13",
	);
});

test("fuso: 01:00Z de 14/10 ainda é 13/10 22:00 em São Paulo (hoje)", () => {
	assert.equal(formatSeparatorLabel(at("2026-10-14T01:00:00Z"), at("2026-10-14T02:00:00Z"), TZ), "22:00");
	// no mesmo instante em UTC já seria outro dia
	assert.equal(
		formatSeparatorLabel(at("2026-10-14T01:00:00Z"), at("2026-10-15T02:00:00Z"), "UTC"),
		"ontem, 01:00",
	);
});

test("meia-noite local não vira 24:00", () => {
	assert.equal(formatSeparatorLabel(at("2026-10-13T03:00:00Z"), NOW, TZ), "00:00");
});

test("primeira mensagem sempre tem separador", () => {
	assert.equal(needsSeparator(null, NOW, TZ), true);
});

test("gap de exatamente 60min não separa; acima separa", () => {
	const a = at("2026-10-13T15:00:00Z");
	assert.equal(needsSeparator(a, at("2026-10-13T16:00:00Z"), TZ), false);
	assert.equal(needsSeparator(a, at("2026-10-13T16:00:01Z"), TZ), true);
});

test("troca de dia local separa mesmo com gap curto", () => {
	// 23:50 e 00:10 locais (UTC-3)
	assert.equal(
		needsSeparator(at("2026-10-14T02:50:00Z"), at("2026-10-14T03:10:00Z"), TZ),
		true,
	);
	// em UTC é o mesmo dia
	assert.equal(
		needsSeparator(at("2026-10-14T02:50:00Z"), at("2026-10-14T03:10:00Z"), "UTC"),
		false,
	);
});

test("buildTimeSeparators: marca primeira, gap e dia; ignora sem data", () => {
	const map = buildTimeSeparators(
		[
			{ id: "a", createdAt: "2026-10-13T20:00:00Z" },
			{ id: "b", createdAt: "2026-10-13T20:10:00Z" },
			{ id: "nodate" },
			{ id: "bad", createdAt: "xx" },
			{ id: "c", createdAt: "2026-10-13T21:20:00Z" },
		],
		NOW,
		TZ,
	);
	assert.deepEqual([...map.keys()], ["a", "c"]);
	assert.equal(map.get("a"), "17:00");
	assert.equal(map.get("c"), "18:20");
});

test("idioma da interface: o rótulo segue a ordem e as palavras do idioma", () => {
	const hoje = at("2026-10-13T20:13:00Z");
	assert.match(formatSeparatorLabel(hoje, NOW, TZ, "en-US"), /^5:13\sPM$/);
	assert.match(formatSeparatorLabel(at("2026-10-12T21:13:00Z"), NOW, TZ, "en-US"), /^yesterday, 6:13\sPM$/);
	assert.match(formatSeparatorLabel(at("2026-10-09T21:13:00Z"), NOW, TZ, "en-US"), /^Fri, Oct 9 6:13\sPM$/);
	assert.match(formatSeparatorLabel(at("2025-10-09T21:13:00Z"), NOW, TZ, "en-US"), /^Oct 9, 2025, 6:13\sPM$/);
	assert.equal(formatSeparatorLabel(at("2026-10-12T21:13:00Z"), NOW, TZ, "es-ES"), "ayer, 18:13");
	assert.equal(formatSeparatorLabel(at("2026-10-12T21:13:00Z"), NOW, TZ), "ontem, 18:13");
});
