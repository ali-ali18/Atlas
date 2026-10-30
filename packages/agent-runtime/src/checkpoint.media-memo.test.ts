import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { createMediaMemo, resolveLlmMessagesForModel } from "./checkpoint.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const history = (): LlmMessage[] => [
	{ role: "user", content: [{ type: "text", text: "olha" }, { type: "image_ref", artifactId: "img1" }] },
	{ role: "assistant", content: "ok" },
	{ role: "tool", tool_call_id: "t1", content: [{ type: "screenshot_ref", artifactId: "s1" }] },
	{ role: "tool", tool_call_id: "t2", content: [{ type: "text", text: "pdf" }, { type: "file_ref", artifactId: "p1", filename: "a.pdf" }, { type: "screenshot_ref", artifactId: "s2" }] },
];

describe("resolveLlmMessagesForModel: paralelo e memo do run", () => {
	it("carrega as mídias em paralelo e mantém a ordem das partes", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<string | null>>>();
		const loader = (prefix: string) => (id: string) => {
			const d = deferred<string | null>();
			pending.set(`${prefix}:${id}`, d);
			return d.promise;
		};
		const result = resolveLlmMessagesForModel(history(), loader("shot"), {
			canSeeUserImages: true,
			loadUserImage: loader("img"),
			canReadNativePdf: true,
			loadUserPdf: loader("pdf"),
		});
		await Promise.resolve();
		// Todas as cargas começaram antes de qualquer uma terminar.
		expect([...pending.keys()].sort()).toEqual(["img:img1", "pdf:p1", "shot:s1", "shot:s2"]);
		// Termina na ordem inversa: a saída segue a ordem do histórico.
		pending.get("shot:s2")!.resolve("data:image/png;base64,S2");
		pending.get("pdf:p1")!.resolve("data:application/pdf;base64,P1");
		pending.get("shot:s1")!.resolve(null);
		pending.get("img:img1")!.resolve("data:image/png;base64,I1");
		const messages = await result;
		expect(messages[0]!.content).toEqual([
			{ type: "text", text: "olha" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,I1" } },
		]);
		expect(messages[1]).toEqual({ role: "assistant", content: "ok" });
		expect(messages[2]!.content).toEqual([{ type: "text", text: "[screenshot artifact:s1]" }]);
		expect(messages[3]!.content).toEqual([
			{ type: "text", text: "pdf" },
			{ type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,P1" } },
			{ type: "image_url", image_url: { url: "data:image/png;base64,S2" } },
		]);
	});

	it("com memo, o passo seguinte não recarrega; ausente e falha tentam de novo", async () => {
		const calls: string[] = [];
		let s1Available = false;
		let failS2 = true;
		const loadScreenshot = async (id: string) => {
			calls.push(`shot:${id}`);
			if (id === "s1") return s1Available ? "data:S1" : null;
			if (failS2) {
				failS2 = false;
				throw new Error("db fora");
			}
			return "data:S2";
		};
		const loadUserImage = async (id: string) => {
			calls.push(`img:${id}`);
			return "data:I1";
		};
		const loadUserPdf = async (id: string) => {
			calls.push(`pdf:${id}`);
			return "data:P1";
		};
		const memo = createMediaMemo();
		const options = { canSeeUserImages: true, loadUserImage, canReadNativePdf: true, loadUserPdf, memo };
		// Passo 1: a falha sobe (como antes) e não fica no memo.
		await expect(resolveLlmMessagesForModel(history(), loadScreenshot, options)).rejects.toThrow("db fora");
		calls.length = 0;
		// Passo 2: só o que não ficou guardado é carregado (s1 ausente e s2 que falhou).
		const second = await resolveLlmMessagesForModel(history(), loadScreenshot, options);
		expect(calls.sort()).toEqual(["shot:s1", "shot:s2"]);
		expect(second[3]!.content).toContainEqual({ type: "image_url", image_url: { url: "data:S2" } });
		calls.length = 0;
		s1Available = true;
		const third = await resolveLlmMessagesForModel(history(), loadScreenshot, options);
		expect(calls).toEqual(["shot:s1"]);
		expect(third[2]!.content).toEqual([{ type: "image_url", image_url: { url: "data:S1" } }]);
		calls.length = 0;
		await resolveLlmMessagesForModel(history(), loadScreenshot, options);
		expect(calls).toEqual([]);
		// O que o passo não usa sai do memo (não retém mídia antiga).
		await resolveLlmMessagesForModel([{ role: "tool", tool_call_id: "t1", content: [{ type: "screenshot_ref", artifactId: "s1" }] }], loadScreenshot, options);
		expect([...memo.keys()]).toEqual(["screenshot:s1"]);
	});

	it("descrição de imagem (modelo sem visão) também é memorizada", async () => {
		let described = 0;
		const memo = createMediaMemo();
		const describeUserImage = async () => {
			described += 1;
			return "um gato";
		};
		const messages: LlmMessage[] = [{ role: "user", content: [{ type: "image_ref", artifactId: "img1" }] }];
		const first = await resolveLlmMessagesForModel(messages, undefined, { canSeeUserImages: false, describeUserImage, memo });
		await resolveLlmMessagesForModel(messages, undefined, { canSeeUserImages: false, describeUserImage, memo });
		expect(described).toBe(1);
		expect(first[0]!.content).toEqual([{ type: "text", text: "[image attached by the user; description by a vision helper: um gato]" }]);
	});

	it("sem memo, cada chamada carrega de novo (comportamento antigo)", async () => {
		let loads = 0;
		const loadScreenshot = async () => {
			loads += 1;
			return "data:S";
		};
		const messages: LlmMessage[] = [{ role: "tool", tool_call_id: "t", content: [{ type: "screenshot_ref", artifactId: "s" }] }];
		await resolveLlmMessagesForModel(messages, loadScreenshot);
		await resolveLlmMessagesForModel(messages, loadScreenshot);
		expect(loads).toBe(2);
	});
});

describe("resolveLlmMessagesForModel: nota de imagem que não carregou", () => {
	const messages = (): LlmMessage[] => [{ role: "user", content: [{ type: "image_ref", artifactId: "img1" }] }];
	const note = async (imageFailure: Parameters<typeof resolveLlmMessagesForModel>[2] extends infer O ? (O extends { imageFailure?: infer F } ? F : never) : never, canSeeUserImages = true) => {
		const [message] = await resolveLlmMessagesForModel(messages(), undefined, { canSeeUserImages, loadUserImage: async () => null, describeUserImage: async () => null, imageFailure });
		return JSON.stringify(message?.content);
	};

	it("anexo atual com aviso já dado: não manda o modelo pedir de novo", async () => {
		const text = await note(() => ({ current: true, notified: true }));
		expect(text).toContain("already told the user");
		expect(text).toContain("do not ask again");
	});

	it("anexo atual sem aviso do sistema (passo de fechamento ou sem canal): o modelo avisa com as próprias palavras", async () => {
		const text = await note(() => ({ current: true, notified: false }));
		expect(text).toContain("Tell the user in your own words");
		expect(text).not.toContain("already told");
	});

	it("imagem de histórico: nota neutra; sem visão e sem falha registrada segue 'cannot see images'", async () => {
		expect(await note(() => ({ current: false, notified: false }))).toContain("attached earlier");
		expect(await note(() => undefined, false)).toContain("cannot see images");
		expect(await note(() => ({ current: true, notified: true }), false)).toContain("could not be loaded");
	});
});
