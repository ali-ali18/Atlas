import { describe, expect, it } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	LISTENING_LABEL,
	applyResult,
	barLine,
	dictationTransition,
	levelFraction,
	mergeDictation,
	problemFromError,
	problemNotice,
	resolveDictation,
	speechLocaleFor,
	spokenText,
} from "./dictation";

describe("speechLocaleFor", () => {
	it("mapeia o idioma do aparelho e cai no pt-BR", () => {
		expect(speechLocaleFor("pt")).toBe("pt-BR");
		expect(speechLocaleFor("en")).toBe("en-US");
		expect(speechLocaleFor("es")).toBe("es-ES");
		expect(speechLocaleFor("ja")).toBe("pt-BR");
		expect(speechLocaleFor(null)).toBe("pt-BR");
	});
});

describe("mergeDictation", () => {
	it("soma ao que já estava digitado sem apagar", () => {
		expect(mergeDictation("Oi", "tudo bem")).toBe("Oi tudo bem");
		expect(mergeDictation("Oi ", "tudo bem")).toBe("Oi tudo bem");
		expect(mergeDictation("", "  tudo   bem ")).toBe("tudo bem");
	});
	it("fala vazia mantém o campo como está", () => {
		expect(mergeDictation("Oi", "   ")).toBe("Oi");
	});
});

describe("transcrição parcial e final", () => {
	it("o parcial substitui o parcial anterior", () => {
		let t = applyResult(EMPTY_TRANSCRIPT, { transcript: "olá", isFinal: false });
		t = applyResult(t, { transcript: "olá mundo", isFinal: false });
		expect(spokenText(t)).toBe("olá mundo");
	});
	it("trechos finais se acumulam e o parcial vem depois", () => {
		let t = applyResult(EMPTY_TRANSCRIPT, { transcript: "primeira frase", isFinal: true });
		t = applyResult(t, { transcript: "segunda", isFinal: false });
		expect(spokenText(t)).toBe("primeira frase segunda");
		t = applyResult(t, { transcript: "segunda frase", isFinal: true });
		expect(spokenText(t)).toBe("primeira frase segunda frase");
		expect(t.partial).toBe("");
	});
	it("final vazio não apaga o que já foi confirmado", () => {
		const t = applyResult({ finals: "oi", partial: "" }, { transcript: "  ", isFinal: true });
		expect(spokenText(t)).toBe("oi");
	});
});

describe("resolveDictation: os três desfechos", () => {
	it("cancelar descarta o falado e deixa o campo intacto", () => {
		expect(resolveDictation("cancel", "rascunho", "texto falado")).toEqual({ text: "rascunho", send: false });
	});
	it("parar e revisar soma ao digitado e não envia", () => {
		expect(resolveDictation("review", "rascunho", "texto falado")).toEqual({ text: "rascunho texto falado", send: false });
	});
	it("parar e enviar soma ao digitado e envia", () => {
		expect(resolveDictation("send", "rascunho", "texto falado")).toEqual({ text: "rascunho texto falado", send: true });
	});
	it("enviar sem nada falado envia o que já estava, e sem nada algum não envia", () => {
		expect(resolveDictation("send", "só isso", "")).toEqual({ text: "só isso", send: true });
		expect(resolveDictation("send", "", "  ")).toEqual({ text: "", send: false });
	});
	it("respeita o limite do campo", () => {
		expect(resolveDictation("review", "abc", "defgh", 6).text).toBe("abc de");
	});
});

describe("dictationTransition", () => {
	it("idle → listening → stopping → idle", () => {
		let phase = dictationTransition("idle", "start");
		expect(phase).toBe("listening");
		phase = dictationTransition(phase, "stop");
		expect(phase).toBe("stopping");
		expect(dictationTransition(phase, "done")).toBe("idle");
	});
	it("cancelar e falhar voltam a idle de qualquer fase; start repetido não reinicia", () => {
		expect(dictationTransition("listening", "cancel")).toBe("idle");
		expect(dictationTransition("stopping", "fail")).toBe("idle");
		expect(dictationTransition("listening", "start")).toBe("listening");
	});
});

describe("barra de voz", () => {
	it("sem texto mostra o placeholder; com texto mostra a fala", () => {
		expect(barLine("  ")).toEqual({ text: LISTENING_LABEL, empty: true });
		expect(barLine("oi  tudo")).toEqual({ text: "oi tudo", empty: false });
	});
	it("volume vira fração de 0 a 1", () => {
		expect(levelFraction(-2)).toBe(0);
		expect(levelFraction(5)).toBe(0.5);
		expect(levelFraction(30)).toBe(1);
		expect(levelFraction(Number.NaN)).toBe(0);
	});
});

describe("erros", () => {
	it("fim sem fala não avisa; permissão leva às configurações", () => {
		expect(problemFromError("no-speech")).toBeNull();
		expect(problemFromError("aborted")).toBeNull();
		expect(problemFromError("not-allowed")).toBe("permission");
		expect(problemFromError("network")).toBe("failed");
		expect(problemNotice("permission").settings).toBe(true);
		expect(problemNotice("missing-module").message).toBe("Voz disponível no app instalado.");
	});
});
