import { describe, expect, it } from "vitest";
import { MAX_BACKSPACES, TYPING_BUFFER, createSerialQueue, createTypingController, diffTyping, needsRefill } from "./computer-typing";
import { checkVmText } from "./computer-text";

describe("diffTyping", () => {
	it("anexar manda só os caracteres novos", () => {
		expect(diffTyping("ab", "abc")).toEqual({ backspaces: 0, text: "c" });
		expect(diffTyping("", "olá mundo")).toEqual({ backspaces: 0, text: "olá mundo" });
	});
	it("apagar n caracteres do fim vira n Backspaces", () => {
		expect(diffTyping("abcd", "ab")).toEqual({ backspaces: 2, text: "" });
		expect(diffTyping("a", "")).toEqual({ backspaces: 1, text: "" });
	});
	it("sem mudança não manda nada", () => {
		expect(diffTyping("abc", "abc")).toEqual({ backspaces: 0, text: "" });
	});
	it("troca no meio ou autocorreção apaga a cauda diferente e digita a nova", () => {
		expect(diffTyping("ola", "olá")).toEqual({ backspaces: 1, text: "á" });
		expect(diffTyping("abcdef", "abXYef")).toEqual({ backspaces: 4, text: "XYef" });
		expect(diffTyping("casa", "carro")).toEqual({ backspaces: 2, text: "rro" });
	});
	it("emoji conta como um caractere e o par substituto não é partido", () => {
		expect(diffTyping("a😀", "a")).toEqual({ backspaces: 1, text: "" });
		expect(diffTyping("a😀", "a😁")).toEqual({ backspaces: 1, text: "😁" });
		expect(diffTyping("a", "a😀")).toEqual({ backspaces: 0, text: "😀" });
	});
});

describe("colchão do campo", () => {
	it("repõe quando o colchão acaba ou o campo cresce demais", () => {
		expect(needsRefill(TYPING_BUFFER)).toBe(false);
		expect(needsRefill(TYPING_BUFFER + "texto")).toBe(false);
		expect(needsRefill(TYPING_BUFFER.slice(0, 7))).toBe(true);
		expect(needsRefill("")).toBe(true);
		expect(needsRefill(TYPING_BUFFER + "x".repeat(401))).toBe(true);
	});
});

describe("fila serial", () => {
	it("roda uma tarefa por vez, em ordem, e uma falha não trava as outras", async () => {
		const log: string[] = [];
		const errors: unknown[] = [];
		const enqueue = createSerialQueue((error) => errors.push(error));
		const slow = (name: string, ms: number, fail = false) => async () => {
			log.push(`${name}:início`);
			await new Promise((resolve) => setTimeout(resolve, ms));
			log.push(`${name}:fim`);
			if (fail) throw new Error(name);
		};
		void enqueue(slow("a", 20));
		void enqueue(slow("b", 1, true));
		await enqueue(slow("c", 1));
		expect(log).toEqual(["a:início", "a:fim", "b:início", "b:fim", "c:início", "c:fim"]);
		expect(errors).toHaveLength(1);
	});
});

function setup() {
	const calls: string[] = [];
	const errors: unknown[] = [];
	const controller = createTypingController({
		sendText: async (text) => void calls.push(`text:${text}`),
		sendKey: async (key) => void calls.push(`key:${key}`),
		onError: (error) => errors.push(error),
	});
	return { controller, calls, errors };
}

describe("controlador da digitação", () => {
	it("digitar manda só o novo, na ordem; o colchão nunca vai à VM", async () => {
		const { controller, calls } = setup();
		let value = controller.initial;
		for (const next of [value + "o", value + "ol", value + "ola"]) {
			controller.change(next);
			value = next;
		}
		await controller.idle();
		expect(calls).toEqual(["text:o", "text:l", "text:a"]);
	});
	it("Backspace no começo do campo (come o colchão) chega à VM", async () => {
		const { controller, calls } = setup();
		controller.change(TYPING_BUFFER.slice(0, -1));
		await controller.idle();
		expect(calls).toEqual(["key:BackSpace"]);
	});
	it("apagar o que foi digitado vira Backspaces; autocorreção apaga e redigita", async () => {
		const { controller, calls } = setup();
		controller.change(TYPING_BUFFER + "ola");
		controller.change(TYPING_BUFFER + "olá");
		controller.change(TYPING_BUFFER + "o");
		await controller.idle();
		expect(calls).toEqual(["text:ola", "key:BackSpace", "text:á", "key:BackSpace", "key:BackSpace"]);
	});
	it("espaço sozinho é uma tecla válida", async () => {
		const { controller, calls } = setup();
		controller.change(TYPING_BUFFER + " ");
		await controller.idle();
		expect(calls).toEqual(["text: "]);
		expect(checkVmText(" ", { allowBlank: true }).ok).toBe(true);
		expect(checkVmText(" ").ok).toBe(false);
		expect(checkVmText("", { allowBlank: true }).ok).toBe(false);
	});
	it("Enter manda Return, em ordem com o texto", async () => {
		const { controller, calls } = setup();
		controller.change(TYPING_BUFFER + "oi");
		controller.submit();
		controller.change(TYPING_BUFFER + "oix");
		await controller.idle();
		expect(calls).toEqual(["text:oi", "key:Return", "text:x"]);
	});
	it("devolve o colchão para repor quando ele acaba, sem mandar nada extra", async () => {
		const { controller, calls } = setup();
		const worn = TYPING_BUFFER.slice(0, 7);
		expect(controller.change(worn)).toBe(TYPING_BUFFER);
		expect(controller.change(TYPING_BUFFER + "a")).toBeNull();
		await controller.idle();
		expect(calls.filter((c) => c === "key:BackSpace")).toHaveLength(17);
		expect(calls.at(-1)).toBe("text:a");
	});
	it("texto longo é dividido no limite de 5000 e Backspaces têm teto", async () => {
		const { controller, calls } = setup();
		controller.change(TYPING_BUFFER + "a".repeat(5001));
		await controller.idle();
		expect(calls.map((c) => c.length)).toEqual(["text:".length + 5000, "text:".length + 1]);
		const again = setup();
		again.controller.change(TYPING_BUFFER + "b".repeat(300));
		await again.controller.idle();
		again.calls.length = 0;
		again.controller.change(TYPING_BUFFER);
		await again.controller.idle();
		expect(again.calls).toHaveLength(MAX_BACKSPACES);
	});
	it("falha de envio vai para onError e a digitação segue", async () => {
		const calls: string[] = [];
		const errors: unknown[] = [];
		let first = true;
		const controller = createTypingController({
			sendText: async (text) => {
				if (first) {
					first = false;
					throw new Error("rede");
				}
				calls.push(text);
			},
			sendKey: async () => undefined,
			onError: (error) => errors.push(error),
		});
		controller.change(TYPING_BUFFER + "a");
		controller.change(TYPING_BUFFER + "ab");
		await controller.idle();
		expect(errors).toHaveLength(1);
		expect(calls).toEqual(["b"]);
	});
});
