import { describe, expect, it } from "vitest";
import { parseVtt, stripVttTags } from "./vtt.js";

describe("stripVttTags", () => {
	it("remove tags de tempo e de classe e decodifica entidades", () => {
		expect(stripVttTags("Olá<00:00:01.200><c> mundo</c> &amp; &lt;você&gt;")).toBe("Olá mundo & <você>");
	});
	it("não decodifica duas vezes", () => {
		expect(stripVttTags("&amp;lt;")).toBe("&lt;");
	});
	it("tag sem fechar descarta o resto da linha, sem travar", () => {
		expect(stripVttTags("texto <c sem fim")).toBe("texto");
	});
});

describe("parseVtt", () => {
	it("vazio ou só cabeçalho devolve nada", () => {
		expect(parseVtt("")).toEqual({ lines: [], text: "", cues: 0 });
		expect(parseVtt("WEBVTT\nKind: captions\nLanguage: pt\n")).toEqual({ lines: [], text: "", cues: 0 });
	});

	it("lê cues simples, ignora identificador, NOTE e STYLE", () => {
		const vtt = [
			"WEBVTT",
			"",
			"NOTE isto é comentário",
			"",
			"STYLE",
			"::cue { color: red }",
			"",
			"1",
			"00:00:00.000 --> 00:00:02.000",
			"Primeira fala.",
			"",
			"2",
			"00:00:02.000 --> 00:00:04.000 align:start",
			"Segunda fala.",
			"",
		].join("\n");
		const out = parseVtt(vtt);
		expect(out.lines).toEqual(["Primeira fala.", "Segunda fala."]);
		expect(out.text).toBe("Primeira fala. Segunda fala.");
		expect(out.cues).toBe(2);
	});

	it("cue com várias linhas mantém a ordem; CRLF e BOM funcionam", () => {
		const vtt = "﻿WEBVTT\r\n\r\n00:00:00.000 --> 00:00:03.000\r\nlinha um\r\nlinha dois\r\n\r\n";
		expect(parseVtt(vtt).lines).toEqual(["linha um", "linha dois"]);
	});

	it("auto-legenda rolada: remove a repetição entre cues e os cues curtos duplicados", () => {
		const vtt = [
			"WEBVTT",
			"",
			"00:00:00.000 --> 00:00:02.000",
			"hoje vamos<00:00:00.500><c> falar</c>",
			"",
			"00:00:02.000 --> 00:00:02.010",
			"hoje vamos falar",
			"",
			"00:00:02.010 --> 00:00:04.000",
			"hoje vamos falar",
			"de <00:00:03.000><c>energia solar</c>",
			"",
			"00:00:04.000 --> 00:00:04.010",
			"de energia solar",
			"",
			"00:00:04.010 --> 00:00:06.000",
			"de energia solar",
			"e baterias",
			"",
		].join("\n");
		const out = parseVtt(vtt);
		expect(out.text).toBe("hoje vamos falar de energia solar e baterias");
		expect(out.cues).toBe(5);
	});

	it("repetição não adjacente é fala e fica", () => {
		const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n[Música]\n\n00:00:01.000 --> 00:00:02.000\nOi\n\n00:00:02.000 --> 00:00:03.000\n[Música]\n";
		expect(parseVtt(vtt).lines).toEqual(["[Música]", "Oi", "[Música]"]);
	});

	it("entrada inválida (sem tempo) não vira texto", () => {
		expect(parseVtt("isto não é uma legenda\nsó texto solto").lines).toEqual([]);
	});

	it("cue só com tags não conta", () => {
		const out = parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c></c>\n");
		expect(out).toEqual({ lines: [], text: "", cues: 0 });
	});
});
