import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import {
	buildObjectiveRevision,
	formatTriagedNote,
	ingestRunInputs,
	JOIN_NOTE_HEADER,
	REDIRECT_NOTE_HEADER,
	USER_MESSAGE_HEADER,
	type PendingRunInput,
} from "./inputs.js";
import type { MessageTriage } from "./message-triage.js";
import { ACK_CONTINUE_PROMPT } from "./transcript.js";

const verdict = (partial: Partial<MessageTriage> & Pick<MessageTriage, "kind">): MessageTriage => ({
	cancel: false,
	reply: "Certo.",
	instruction: "",
	...partial,
});

function setup(conversation: LlmMessage[], overrides: Partial<Parameters<typeof ingestRunInputs>[1]> = {}) {
	const revisions: Array<{ text: string; reason: string }> = [];
	const consumedEvents: Array<{ inputId: string; mode: string }> = [];
	const replies: string[] = [];
	const queued: Array<{ instruction: string; key: string }> = [];
	return {
		revisions,
		consumedEvents,
		replies,
		queued,
		deps: {
			conversation: () => conversation,
			consumed: new Set<string>(),
			reviseObjective: (text: string, reason: string) => void revisions.push({ text, reason }),
			onConsumed: async (event: { inputId: string; mode: string }) => void consumedEvents.push(event),
			onReply: (text: string) => void replies.push(text),
			queueFollowUp: async (instruction: string, key: string) => void queued.push({ instruction, key }),
			...overrides,
		} as Parameters<typeof ingestRunInputs>[1],
	};
}

const input = (id: string, content: string, mode?: string): PendingRunInput => ({ id, content, mode });
const base = (): LlmMessage[] => [{ role: "user", content: "objetivo" }, { role: "assistant", content: "ok" }];

describe("ingestRunInputs: triagem das mensagens join", () => {
	it("chat: responde, injeta a nota, não revisa o objetivo", async () => {
		const conversation = base();
		const { deps, revisions, replies, consumedEvents } = setup(conversation, {
			triage: async () => verdict({ kind: "chat", reply: "Boa noite! Sigo com a pesquisa." }),
		});
		const outcome = await ingestRunInputs([input("a", "boa noite", "join")], deps);
		expect(outcome).toMatchObject({ ingested: true, joined: 1, redirected: 0 });
		expect(revisions).toEqual([]);
		expect(replies).toEqual(["Boa noite! Sigo com a pesquisa."]);
		expect(conversation.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(String(conversation[2]!.content)).toContain(JOIN_NOTE_HEADER);
		expect(conversation[3]!.content).toBe("Boa noite! Sigo com a pesquisa.");
		expect(conversation[4]!.content).toBe(ACK_CONTINUE_PROMPT);
		expect(consumedEvents).toEqual([{ inputId: "a", mode: "join", content: "boa noite" }]);
	});

	it("steer legado passa pela mesma triagem", async () => {
		const { deps, replies } = setup(base(), { triage: async () => verdict({ kind: "chat" }) });
		const outcome = await ingestRunInputs([input("a", "boa noite", "steer")], deps);
		expect(outcome.joined).toBe(1);
		expect(replies).toEqual(["Certo."]);
	});

	it("change: revisa o objetivo com a instrução (user_message) e usa o cabeçalho de mudança", async () => {
		const conversation = base();
		const { deps, revisions, replies } = setup(conversation, {
			triage: async () => verdict({ kind: "change", reply: "Incluo o Gemini.", instruction: "Compare A, B e Gemini." }),
		});
		const outcome = await ingestRunInputs([input("a", "na verdade compara com o Gemini", "join")], deps);
		expect(outcome).toMatchObject({ redirected: 1, joined: 0 });
		expect(revisions).toEqual([{ text: "Compare A, B e Gemini.", reason: "user_message" }]);
		expect(replies).toEqual(["Incluo o Gemini."]);
		expect(String(conversation[2]!.content)).toContain(REDIRECT_NOTE_HEADER);
	});

	it("change acima do limite de revisões vira cabeçalho neutro, sem balão nem revisão", async () => {
		const conversation = base();
		const { deps, revisions, replies } = setup(conversation, {
			canRevise: () => false,
			triage: async () => verdict({ kind: "change", instruction: "outra coisa" }),
		});
		await ingestRunInputs([input("a", "muda tudo", "join")], deps);
		expect(revisions).toEqual([]);
		expect(replies).toEqual([]);
		expect(String(conversation.at(-1)!.content)).toContain(USER_MESSAGE_HEADER);
	});

	it("cancel: consome, mostra a resposta e sinaliza o cancelamento sem escrever nota", async () => {
		const conversation = base();
		const { deps, replies } = setup(conversation, {
			triage: async () => verdict({ kind: "change", cancel: true, reply: "Parei." }),
		});
		const outcome = await ingestRunInputs([input("a", "cancela isso", "join")], deps);
		expect(outcome.cancelled?.id).toBe("a");
		expect(replies).toEqual(["Parei."]);
		expect(deps.consumed.has("a")).toBe(true);
		expect(conversation).toHaveLength(2);
	});

	it("later: guarda o pedido com chave estável, não revisa o objetivo", async () => {
		const { deps, queued, revisions, replies } = setup(base(), {
			triage: async () => verdict({ kind: "later", reply: "Mando depois.", instruction: "Send a summary." }),
		});
		await ingestRunInputs([input("a", "depois me manda um resumo", "join")], deps);
		expect(queued).toEqual([{ instruction: "Send a summary.", key: "later:a" }]);
		expect(revisions).toEqual([]);
		expect(replies).toEqual(["Mando depois."]);
	});

	it("later: falha ao guardar não derruba a ingestão", async () => {
		const { deps } = setup(base(), {
			triage: async () => verdict({ kind: "later", instruction: "x" }),
			queueFollowUp: async () => {
				throw new Error("db");
			},
		});
		const outcome = await ingestRunInputs([input("a", "depois", "join")], deps);
		expect(outcome.ingested).toBe(true);
	});

	it.each([
		["sem triagem", undefined],
		["triagem sem veredito", async () => null],
		["triagem que lança", async () => Promise.reject(new Error("rede"))],
	])("%s: cabeçalho neutro, sem balão, a mensagem é consumida", async (_name, triage) => {
		const conversation = base();
		const { deps, replies, revisions } = setup(conversation, { triage });
		const outcome = await ingestRunInputs([input("a", "faça outra coisa", "join")], deps);
		expect(outcome.ingested).toBe(true);
		expect(replies).toEqual([]);
		expect(revisions).toEqual([]);
		expect(conversation.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(conversation[2]!.content).toBe(
			`${USER_MESSAGE_HEADER}\nfaça outra coisa\n(If it changes or cancels the task, follow it; otherwise reply briefly and continue the original task.)`,
		);
	});

	it("rajada: uma única triagem com as mensagens juntas, na ordem, e uma única nota", async () => {
		const seen: string[] = [];
		const conversation = base();
		const { deps, consumedEvents } = setup(conversation, {
			triage: async (message: string) => {
				seen.push(message);
				return verdict({ kind: "chat" });
			},
		});
		await ingestRunInputs([input("a", "primeira", "join"), input("b", "segunda", "join")], deps);
		expect(seen).toEqual(["Message 1 of 2: primeira\nMessage 2 of 2: segunda"]);
		expect(consumedEvents.map((e) => e.inputId)).toEqual(["a", "b"]);
		// objetivo, uma única nota (as duas mensagens juntas) e a continuação.
		expect(conversation.filter((m) => m.role === "user" && String(m.content).includes("primeira"))).toHaveLength(1);
	});

	it("lote de tools aberto: nada é triado nem consumido; na fronteira seguinte entra (alternância respeitada)", async () => {
		const conversation: LlmMessage[] = [
			{ role: "user", content: "objetivo" },
			{ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
		];
		let triageCalls = 0;
		const { deps, replies } = setup(conversation, {
			triage: async () => {
				triageCalls += 1;
				return verdict({ kind: "chat", reply: "Oi!" });
			},
		});
		const first = await ingestRunInputs([input("a", "oi", "join")], deps);
		expect(first.ingested).toBe(false);
		expect(triageCalls).toBe(0);
		expect(conversation).toHaveLength(2);
		conversation.push({ role: "tool", tool_call_id: "t1", content: "r" });
		await ingestRunInputs([input("a", "oi", "join")], deps);
		expect(replies).toEqual(["Oi!"]);
		expect(conversation.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "user"]);
	});

	it("lote que abre durante a triagem: a nota espera, sem balão nem consumo", async () => {
		const conversation = base();
		const { deps, replies } = setup(conversation, {
			triage: async () => {
				conversation.push({
					role: "assistant",
					content: null,
					tool_calls: [{ id: "t9", type: "function", function: { name: "x", arguments: "{}" } }],
				});
				return verdict({ kind: "chat" });
			},
		});
		const outcome = await ingestRunInputs([input("a", "oi", "join")], deps);
		expect(outcome.ingested).toBe(false);
		expect(replies).toEqual([]);
		expect(deps.consumed.size).toBe(0);
	});

	it("preserva image_ref dos anexos", async () => {
		const conversation = base();
		const { deps } = setup(conversation);
		await ingestRunInputs([{ id: "a", content: "veja", mode: "join", attachments: [{ artifactId: "img1" }] }], deps);
		expect(conversation[2]!.content).toEqual([
			expect.objectContaining({ type: "text" }),
			{ type: "image_ref", artifactId: "img1" },
		]);
	});
});

describe("ingestRunInputs: modos explícitos mantêm o comportamento", () => {
	it("redirect revisa o objetivo com o motivo e nunca chama a triagem", async () => {
		const conversation = base();
		let triaged = false;
		const { deps, revisions } = setup(conversation, {
			triage: async () => {
				triaged = true;
				return null;
			},
		});
		const outcome = await ingestRunInputs([input("a", "faça um resumo", "redirect")], deps);
		expect(outcome.redirected).toBe(1);
		expect(triaged).toBe(false);
		expect(revisions).toEqual([{ text: "faça um resumo", reason: "user asked to redirect" }]);
		expect(String(conversation.at(-1)!.content)).toContain(REDIRECT_NOTE_HEADER);
	});

	it("interrupt é processado como redirect", async () => {
		const { deps, revisions } = setup(base());
		await ingestRunInputs([input("a", "pare e faça X", "interrupt")], deps);
		expect(revisions).toEqual([{ text: "pare e faça X", reason: "user interrupted and redirected" }]);
	});

	it("queue fica pendente; cancel interrompe o consumo", async () => {
		const conversation = base();
		const { deps } = setup(conversation);
		const outcome = await ingestRunInputs([input("q", "depois", "queue"), input("c", "para", "cancel"), input("j", "nota", "join")], deps);
		expect(outcome.cancelled?.id).toBe("c");
		expect(deps.consumed.has("q")).toBe(false);
		expect(deps.consumed.has("j")).toBe(false);
		expect(conversation).toHaveLength(2);
	});
});

describe("formatTriagedNote", () => {
	it("cada veredito tem o seu cabeçalho", () => {
		expect(formatTriagedNote(null, "x")).toContain(USER_MESSAGE_HEADER);
		expect(formatTriagedNote(verdict({ kind: "chat" }), "x")).toContain(JOIN_NOTE_HEADER);
		expect(formatTriagedNote(verdict({ kind: "later", instruction: "y" }), "x")).toContain("after the current task");
		expect(formatTriagedNote(verdict({ kind: "change", instruction: "y" }), "x")).toContain(REDIRECT_NOTE_HEADER);
	});
});

describe("buildObjectiveRevision", () => {
	it("registra texto anterior, novo, motivo e versão; sem mudança devolve null", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		expect(
			buildObjectiveRevision({ before: { text: "a", version: 1 }, after: { text: "b", version: 2 }, reason: "r", step: 3, now }),
		).toEqual({ previousText: "a", newText: "b", reason: "r", version: 2, at: now.toISOString(), atStep: 3 });
		expect(buildObjectiveRevision({ before: { text: "a", version: 1 }, after: { text: "a", version: 1 }, reason: "r" })).toBeNull();
	});
});

describe("ingestRunInputs: rajada já triada durante tool longa", () => {
	it("entra no histórico sem triar de novo, sem repetir balão nem follow-up, e sai da lista", async () => {
		const conversation = base();
		let triageCalls = 0;
		const triaged = [{ ids: ["i1"], text: "depois faz tabela", verdict: verdict({ kind: "later", instruction: "Tabela" }) }];
		const { deps, replies, queued, consumedEvents } = setup(conversation, {
			triaged,
			triage: async () => {
				triageCalls += 1;
				return null;
			},
		});
		const outcome = await ingestRunInputs([input("i1", "depois faz tabela", "join")], deps);
		expect(triageCalls).toBe(0);
		expect(replies).toEqual([]);
		expect(queued).toEqual([]);
		expect(outcome).toMatchObject({ ingested: true, joined: 1 });
		expect(consumedEvents.map((event) => event.inputId)).toEqual(["i1"]);
		expect(conversation.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(conversation[3]).toMatchObject({ content: "Certo." });
		expect(conversation[4]).toMatchObject({ content: ACK_CONTINUE_PROMPT });
		expect(triaged).toHaveLength(0);
	});

	it("cancel já triado: encerra o run sem repetir o balão", async () => {
		const triaged = [{ ids: ["i1"], text: "para", verdict: verdict({ kind: "change", cancel: true }) }];
		const { deps, replies } = setup(base(), { triaged });
		const outcome = await ingestRunInputs([input("i1", "para", "join")], deps);
		expect(outcome.cancelled?.id).toBe("i1");
		expect(replies).toEqual([]);
	});

	it("mistura: a já triada entra sem chamada e a nova é triada normalmente", async () => {
		let triageCalls = 0;
		const triaged = [{ ids: ["i1"], text: "oi", verdict: verdict({ kind: "chat", reply: "Oi!" }) }];
		const { deps, replies } = setup(base(), {
			triaged,
			triage: async () => {
				triageCalls += 1;
				return verdict({ kind: "chat", reply: "Nova." });
			},
		});
		await ingestRunInputs([input("i1", "oi", "join"), input("i2", "e aí", "join")], deps);
		expect(triageCalls).toBe(1);
		expect(replies).toEqual(["Nova."]);
	});
});

describe("ordem das mensagens enviadas durante o run", () => {
	it("mensagens que chegam em pontos seguros diferentes entram em notas separadas, na ordem em que chegaram", async () => {
		const conversation = base();
		const { deps } = setup(conversation, { triage: async () => verdict({ kind: "chat" }) });
		await ingestRunInputs([input("a", "Vc n fez o login, puxe do cofre", "join")], deps);
		conversation.push({ role: "assistant", content: "passo 2" });
		await ingestRunInputs([input("b", "N consegue né", "join")], deps);
		conversation.push({ role: "assistant", content: "passo 3" });
		await ingestRunInputs([input("c", "Mas eh falei do gpt", "join")], deps);
		const users = conversation.filter((m) => m.role === "user" && String(m.content).includes(JOIN_NOTE_HEADER));
		expect(users.map((m) => String(m.content).split("\n")[1])).toEqual([
			"Vc n fez o login, puxe do cofre",
			"N consegue né",
			"Mas eh falei do gpt",
		]);
		const text = conversation.map((m) => String(m.content));
		expect(text.findIndex((t) => t.includes("N consegue"))).toBeGreaterThan(text.findIndex((t) => t === "passo 2"));
		expect(text.findIndex((t) => t.includes("Mas eh falei"))).toBeGreaterThan(text.findIndex((t) => t === "passo 3"));
	});

	it("rajada de várias mensagens: cada uma numerada e separada na nota", async () => {
		const conversation = base();
		const { deps } = setup(conversation, { triage: async () => verdict({ kind: "chat" }) });
		await ingestRunInputs([input("a", "um", "join"), input("b", "dois", "join"), input("c", "três", "join")], deps);
		const note = conversation.map((m) => String(m.content)).find((c) => c.includes("Message 1 of 3")) ?? "";
		expect(note).toContain("Message 1 of 3: um\nMessage 2 of 3: dois\nMessage 3 of 3: três");
	});
});
