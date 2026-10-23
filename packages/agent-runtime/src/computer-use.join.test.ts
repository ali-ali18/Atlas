import { WANTS_FILE_JEV } from "./jev/test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { AgentRunCancelledError, runComputerUse } from "./computer-use.js";
import { JOIN_NOTE_HEADER, REDIRECT_NOTE_HEADER, USER_MESSAGE_HEADER } from "./loop/inputs.js";
import { MISSING_ARTIFACT_NOTE } from "./execution/task-state.js";
import { MESSAGE_TRIAGE_SYSTEM } from "./loop/message-triage.js";
import { appendedToolNotes } from "./loop/tool-result-notes.js";

/** F1 — mensagem mid-run entra como join: não reescreve o objetivo (Bug A, run cmuxij8ix000rlg3c1s1kkfmr; #35). */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchMemoryEntries: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
			id: `art-${Math.random().toString(36).slice(2, 8)}`,
			kind: input.kind,
			meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
			runId: "run-join",
			conversationId: "conv-join",
			createdAt: new Date(),
		})),
		nextFileVersion: vi.fn(async () => 1),
		countRunFileArtifacts: vi.fn(async () => 0),
	};
});

vi.mock("./files/pdf-chromium.js", () => ({
	printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake")),
}));

const OBJECTIVE = "Pesquise sobre o mercado de baterias e gere um relatório em PDF.";
const PLAIN_OBJECTIVE = "Pesquise sobre o mercado de baterias.";
const GOODBYE = "Vou dormir, amanhã vc me fala o que encontrou, boa noite";

const call = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
	},
});
const text = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

/** Resposta da triagem (JSON) como o modelo barato devolveria. */
const triageJson = (value: Record<string, unknown>): CompleteChatWithToolsResult => text(JSON.stringify(value));

/**
 * `triage` responde às chamadas de triagem (identificadas pelo system prompt); sem ele a
 * triagem falha e entra o cabeçalho neutro. Essas chamadas não consomem o `script` do run.
 */
function harness(
	script: CompleteChatWithToolsResult[],
	extra: Record<string, unknown> = {},
	objective = OBJECTIVE,
	triage?: (params: CompleteChatWithToolsParams) => CompleteChatWithToolsResult | Promise<CompleteChatWithToolsResult>,
) {
	const triageCalls: CompleteChatWithToolsParams[] = [];
	const requests: LlmMessage[][] = [];
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	let index = 0;
	const execute = () =>
		runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sem sandbox");
			},
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: objective }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-join",
			runId: "run-join",
			origin: "chat",
			maxSteps: 12,
			onEvent: (event) => void events.push(event as never),
			onCheckpoint: async (value) => void checkpoints.push(structuredClone(value)),
			streamChat: async (params: CompleteChatWithToolsParams) => {
				if (String(params.messages[0]?.content).startsWith(MESSAGE_TRIAGE_SYSTEM)) {
					triageCalls.push(params);
					if (!triage) throw new Error("triagem indisponível");
					return triage(params);
				}
				requests.push(structuredClone(params.messages));
				const next = script[index++];
				if (!next) throw new Error("LLM extra");
				return next;
			},
			...extra,
		} as never);
	return { execute, requests, events, checkpoints, triageCalls };
}

describe("F1: join não reescreve o objetivo", () => {
	it("replay 'vou dormir': objetivo original, run conclui com o PDF e a resposta cobre o pedido", async () => {
		let calls = 0;
		const { execute, requests, events, checkpoints } = harness(
			[
				call("c1", "memory_search", { query: "baterias" }),
				// O bug original: o modelo respondia só sobre a despedida/memória e encerrava sem PDF.
				text("Anotei que você vai dormir, boa noite!"),
				call("c2", "create_file", { filename: "baterias.pdf", content: "# Mercado de baterias\n\nResumo da pesquisa.\n" }),
				text("Pronto: o relatório em PDF sobre baterias está feito. Boa noite, depois me diga o que achou."),
			],
			{
				// Linha real do RunInput: chegou como steer legado no meio do run.
				consumeSteerInputs: async () => (++calls >= 2 ? [{ id: "in-sleep", content: GOODBYE, mode: "steer" }] : []),
				jev: WANTS_FILE_JEV,
			},
		);
		const result = await execute();

		const last = checkpoints.at(-1)!;
		expect(last.taskState?.objective).toEqual({ text: OBJECTIVE, version: 1 });
		expect(last.objectiveRevisions ?? []).toEqual([]);
		expect(last.taskState?.phase).toBe("done");
		expect(result.text).toContain("relatório em PDF");
		expect(events.some((e) => e.type === "file")).toBe(true);
		expect(events.some((e) => e.type === "input_consumed" && e.mode === "join")).toBe(true);
		// Triagem indisponível: cabeçalho neutro, a despedida não vira nova tarefa e não há balão.
		const withNote = requests[1]!.filter((m) => m.role === "user").map((m) => String(m.content));
		expect(withNote.some((c) => c.includes(USER_MESSAGE_HEADER) && c.includes(GOODBYE))).toBe(true);
		// A promessa sem arquivo foi cobrada (a despedida não é evidência de conclusão).
		expect(requests[2]!.some((m) => m.role === "system" && String(m.content).includes("no file has been created"))).toBe(true);
	});

	it("redirect pedido pelo cliente é versionado no checkpoint", async () => {
		let calls = 0;
		const { execute, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Aqui vai o resumo de 3 linhas.")],
			{
				consumeSteerInputs: async () =>
					++calls >= 2 ? [{ id: "in-redirect", content: "Na verdade, quero só um resumo em 3 linhas,", mode: "redirect" }] : [],
			},
		);
		await execute();
		const last = checkpoints.at(-1)!;
		expect(last.taskState?.objective.version).toBe(2);
		expect(last.taskState?.objective.text).toContain("resumo em 3 linhas");
		expect(last.objectiveRevisions).toEqual([
			expect.objectContaining({ previousText: OBJECTIVE, version: 2, reason: "user asked to redirect", newText: expect.stringContaining("resumo") }),
		]);
		// O arquivo exigido pelo objetivo antigo deixa de ser critério.
		expect(last.taskState?.criteria.find((item) => item.id === "artifact:file")).toBeUndefined();
	});

	it("interrupt aborta a chamada em voo, descarta a resposta parcial e processa como redirect", async () => {
		let interruptPending = false;
		const requests: LlmMessage[][] = [];
		const checkpoints: AgentRunCheckpoint[] = [];
		let calls = 0;
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sem sandbox");
			},
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: OBJECTIVE }],
			userId: "user-1",
			runId: "run-join",
			origin: "chat",
			maxSteps: 6,
			onEvent: () => undefined,
			onCheckpoint: async (value) => void checkpoints.push(structuredClone(value)),
			interruptPollMs: 5,
			peekInterruptInputs: async () => (interruptPending ? ["in-int"] : []),
			consumeSteerInputs: async () => (interruptPending ? [{ id: "in-int", content: "Pare e me diga só a capital da França", mode: "interrupt" }] : []),
			streamChat: async (params: CompleteChatWithToolsParams, handlers?: { onDelta?: (delta: string) => void }) => {
				requests.push(structuredClone(params.messages));
				calls += 1;
				if (calls === 1) {
					handlers?.onDelta?.("Resposta parcial que será descartada");
					setTimeout(() => {
						interruptPending = true;
					}, 10);
					await new Promise<never>((_resolve, reject) => {
						params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				}
				return text("A capital da França é Paris.");
			},
		} as never);

		expect(result.text).toBe("A capital da França é Paris.");
		expect(calls).toBe(2);
		const second = requests[1]!;
		expect(JSON.stringify(second)).not.toContain("Resposta parcial");
		expect(second.some((m) => m.role === "user" && String(m.content).includes(REDIRECT_NOTE_HEADER))).toBe(true);
		const last = checkpoints.at(-1)!;
		expect(last.taskState?.objective.version).toBe(2);
		expect(last.objectiveRevisions?.[0]).toMatchObject({ reason: "user interrupted and redirected", previousText: OBJECTIVE });
	});
});

describe("triagem: o agente decide o que a mensagem significa", () => {
	const consumeOnce = (content: string, mode = "join") => {
		let calls = 0;
		return async () => (++calls === 2 ? [{ id: "in-1", content, mode }] : []);
	};
	const bubbles = (events: Array<Record<string, unknown> & { type: string }>) =>
		events.filter((e) => e.type === "assistant_delta" && String(e.id).includes("-reply")).map((e) => String(e.delta));

	it("chat (boa noite): balão na hora, a tarefa segue, o PDF sai e o objetivo não muda", async () => {
		const { execute, requests, events, checkpoints, triageCalls } = harness(
			[
				call("c1", "memory_search", { query: "baterias" }),
				call("c2", "create_file", { filename: "baterias.pdf", content: "# Baterias\n\nResumo.\n" }),
				text("Pronto: o relatório em PDF sobre baterias está feito."),
			],
			{ consumeSteerInputs: consumeOnce(GOODBYE) },
			OBJECTIVE,
			() => triageJson({ kind: "chat", cancel: false, reply: "Boa noite! Sigo com a pesquisa.", instruction: "" }),
		);
		await execute();
		expect(triageCalls).toHaveLength(1);
		expect(String(triageCalls[0]!.messages[1]!.content)).toContain(OBJECTIVE);
		expect(bubbles(events)).toEqual(["Boa noite! Sigo com a pesquisa."]);
		expect(events.some((e) => e.type === "file")).toBe(true);
		const last = checkpoints.at(-1)!;
		expect(last.taskState?.objective).toEqual({ text: OBJECTIVE, version: 1 });
		expect(last.objectiveRevisions ?? []).toEqual([]);
		// Histórico: nota, resposta do assistente, continuação; nunca termina em assistant.
		const second = requests[1]!;
		expect(second.at(-1)!.role).toBe("user");
		expect(second.some((m) => m.role === "assistant" && m.content === "Boa noite! Sigo com a pesquisa.")).toBe(true);
		expect(second.some((m) => m.role === "user" && String(m.content).includes(JOIN_NOTE_HEADER))).toBe(true);
	});

	it("change com wantsFile (triagem, qualquer idioma): o novo pedido passa a exigir o arquivo", async () => {
		const noteSeen = async (wantsFile: boolean) => {
			const { execute, requests } = harness(
				[call("c1", "memory_search", { query: "x" }), text("Voici le résumé."), text("Je n'ai pas pu créer le fichier.")],
				{ consumeSteerInputs: consumeOnce("en fait, fais-en un PDF") },
				"Résume le sujet.",
				() => triageJson({ kind: "change", cancel: false, reply: "D'accord.", instruction: "Résume le sujet dans un PDF.", wantsFile }),
			);
			await execute();
			return requests.some((request) => request.some((m) => m.role === "system" && m.content === MISSING_ARTIFACT_NOTE));
		};
		expect(await noteSeen(true)).toBe(true);
		expect(await noteSeen(false)).toBe(false);
	});

	it("change: balão, revisão versionada (user_message) e cabeçalho de mudança", async () => {
		const { execute, requests, events, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Comparei com o Gemini também.")],
			{ consumeSteerInputs: consumeOnce("na verdade compara com o Gemini também") },
			"Compare o Claude com o GPT.",
			() =>
				triageJson({
					kind: "change",
					cancel: false,
					reply: "Certo, incluo o Gemini na comparação.",
					instruction: "Compare o Claude com o GPT e o Gemini.",
				}),
		);
		await execute();
		expect(bubbles(events)).toEqual(["Certo, incluo o Gemini na comparação."]);
		const last = checkpoints.at(-1)!;
		expect(last.taskState?.objective).toMatchObject({ version: 2, text: "Compare o Claude com o GPT e o Gemini." });
		expect(last.objectiveRevisions).toEqual([
			expect.objectContaining({ reason: "user_message", previousText: "Compare o Claude com o GPT.", version: 2 }),
		]);
		expect(requests[1]!.some((m) => m.role === "user" && String(m.content).includes(REDIRECT_NOTE_HEADER))).toBe(true);
	});

	it("entrega offline: mensagem de ausência (qualquer idioma) avisa o worker com o horário combinado, sem mexer no objetivo", async () => {
		const notes: Array<{ deliverAt: string }> = [];
		const { execute, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Relatório pronto.")],
			{
				consumeSteerInputs: consumeOnce("je vais dormir, dis-moi demain à 7h"),
				onAwayNote: async (note: { deliverAt: string }) => void notes.push(note),
			},
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "chat", cancel: false, reply: "Bonne nuit.", instruction: "", away: true, deliverAt: "2026-10-12T07:00" }),
		);
		await execute();
		expect(notes).toEqual([{ deliverAt: "2026-10-12T07:00" }]);
		expect(checkpoints.at(-1)!.taskState?.objective.version).toBe(1);
	});

	it("entrega offline: sem away na triagem, o worker não é avisado; falha do aviso não derruba o run", async () => {
		const notes: unknown[] = [];
		const quiet = harness(
			[call("c1", "memory_search", { query: "x" }), text("ok")],
			{ consumeSteerInputs: consumeOnce("legal"), onAwayNote: async (n: unknown) => void notes.push(n) },
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "chat", cancel: false, reply: "Sim.", instruction: "" }),
		);
		await quiet.execute();
		expect(notes).toEqual([]);
		const broken = harness(
			[call("c1", "memory_search", { query: "x" }), text("ok")],
			{
				consumeSteerInputs: consumeOnce("vou dormir"),
				onAwayNote: async () => {
					throw new Error("db fora");
				},
			},
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "chat", cancel: false, reply: "Boa noite.", instruction: "", away: true, deliverAt: "" }),
		);
		expect((await broken.execute()).text).toBe("ok");
	});

	it("later: balão, pedido guardado no checkpoint e na fila (chave idempotente), o run segue", async () => {
		const queued: Array<{ instruction: string; key: string }> = [];
		const { execute, events, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Relatório pronto.")],
			{
				consumeSteerInputs: consumeOnce("depois me manda um resumo"),
				queueFollowUp: async (instruction: string, key: string) => void queued.push({ instruction, key }),
			},
			PLAIN_OBJECTIVE,
			() =>
				triageJson({ kind: "later", cancel: false, reply: "Combinado, mando o resumo depois.", instruction: "Send the user a short summary." }),
		);
		const result = await execute();
		expect(result.text).toBe("Relatório pronto.");
		expect(bubbles(events)).toEqual(["Combinado, mando o resumo depois."]);
		expect(queued).toEqual([{ instruction: "Send the user a short summary.", key: "later:in-1" }]);
		const last = checkpoints.at(-1)!;
		expect(last.pendingFollowUps).toEqual(["Send the user a short summary."]);
		expect(last.taskState?.objective.version).toBe(1);
	});

	it("later: falha ao enfileirar não derruba o run", async () => {
		const { execute, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Relatório pronto.")],
			{
				consumeSteerInputs: consumeOnce("depois me manda um resumo"),
				queueFollowUp: async () => {
					throw new Error("db fora");
				},
			},
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "later", cancel: false, reply: "Combinado.", instruction: "Send a summary." }),
		);
		expect((await execute()).text).toBe("Relatório pronto.");
		expect(checkpoints.at(-1)!.pendingFollowUps).toEqual(["Send a summary."]);
	});

	it("cancel: o run termina cancelado e a resposta aparece", async () => {
		const { execute, events } = harness(
			[call("c1", "memory_search", { query: "x" }), text("não deveria chegar aqui")],
			{ consumeSteerInputs: consumeOnce("cancela isso") },
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "change", cancel: true, reply: "Tudo bem, parei a tarefa.", instruction: "" }),
		);
		await expect(execute()).rejects.toBeInstanceOf(AgentRunCancelledError);
		expect(bubbles(events)).toEqual(["Tudo bem, parei a tarefa."]);
	});

	it.each([
		["JSON inválido", () => text("claro, boa noite!")],
		["kind desconhecido", () => triageJson({ kind: "other", cancel: false, reply: "x", instruction: "" })],
	])("%s: cabeçalho neutro, sem balão, o run continua", async (_name, triage) => {
		const { execute, requests, events, checkpoints } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Concluído.")],
			{ consumeSteerInputs: consumeOnce(GOODBYE) },
			PLAIN_OBJECTIVE,
			triage,
		);
		expect((await execute()).text).toBe("Concluído.");
		expect(bubbles(events)).toEqual([]);
		const note = requests[1]!
			.filter((m) => m.role === "user")
			.map((m) => String(m.content))
			.find((c) => c.includes(GOODBYE))!;
		expect(note).toBe(
			`${USER_MESSAGE_HEADER}\n${GOODBYE}\n(If it changes or cancels the task, follow it; otherwise reply briefly and continue the original task.)`,
		);
		expect(checkpoints.at(-1)!.taskState?.objective.version).toBe(1);
	});

	it("timeout da triagem: cabeçalho neutro e o run segue", async () => {
		const { execute, requests, events } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Concluído.")],
			{ consumeSteerInputs: consumeOnce(GOODBYE) },
			PLAIN_OBJECTIVE,
			() => new Promise<never>(() => undefined),
		);
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const run = execute();
			await vi.advanceTimersByTimeAsync(11_000);
			expect((await run).text).toBe("Concluído.");
		} finally {
			vi.useRealTimers();
		}
		expect(bubbles(events)).toEqual([]);
		expect(requests[1]!.some((m) => String(m.content).includes(USER_MESSAGE_HEADER))).toBe(true);
	});

	it("rajada de 2 mensagens: uma única triagem, uma única nota", async () => {
		let calls = 0;
		const { execute, requests, triageCalls } = harness(
			[call("c1", "memory_search", { query: "x" }), text("Concluído.")],
			{
				consumeSteerInputs: async () =>
					++calls === 2
						? [
								{ id: "a", content: "boa noite", mode: "join" },
								{ id: "b", content: "vou dormir", mode: "join" },
							]
						: [],
			},
			PLAIN_OBJECTIVE,
			() => triageJson({ kind: "chat", cancel: false, reply: "Boa noite!", instruction: "" }),
		);
		await execute();
		expect(triageCalls).toHaveLength(1);
		expect(String(triageCalls[0]!.messages[1]!.content)).toContain("Message 1 of 2: boa noite\nMessage 2 of 2: vou dormir");
		const notes = requests[1]!.filter((m) => m.role === "user" && String(m.content).includes(JOIN_NOTE_HEADER));
		expect(notes).toHaveLength(1);
	});

	it("limite de 5 revisões por mensagem: a sexta cai no cabeçalho neutro, sem nova versão", async () => {
		let calls = 0;
		const script: CompleteChatWithToolsResult[] = [];
		for (let i = 0; i < 6; i += 1) script.push(call(`c${i}`, "memory_search", { query: `q${i}` }));
		script.push(text("Concluído."));
		const { execute, requests, checkpoints } = harness(
			script,
			{
				maxSteps: 20,
				consumeSteerInputs: async () => {
					calls += 1;
					return calls >= 2 && calls <= 7 ? [{ id: `m${calls}`, content: `muda para variante ${calls}`, mode: "join" }] : [];
				},
			},
			PLAIN_OBJECTIVE,
			(params) => {
				const n = String(params.messages[1]!.content).split("User message:").at(-1)!.match(/variante (\d)/)?.[1];
				return triageJson({ kind: "change", cancel: false, reply: `ok ${n}`, instruction: `Nova tarefa ${n}` });
			},
		);
		await execute();
		const last = checkpoints.at(-1)!;
		expect(last.objectiveRevisions?.filter((r) => r.reason === "user_message")).toHaveLength(5);
		expect(last.taskState?.objective.text).toBe("Nova tarefa 6");
		expect(requests.flat().some((m) => String(m.content).includes(`${USER_MESSAGE_HEADER}\nmuda para variante 7`))).toBe(true);
	});
});

describe("mensagem do usuário durante a tarefa depois de tirar os `system` do meio do run", () => {
	it("continua chegando ao modelo no meio do run como fala do usuário; avisos do runtime vão no resultado da tool", async () => {
		let calls = 0;
		const NOTE = "Também inclui os preços de 2025, por favor.";
		const { execute, requests } = harness(
			[
				call("c1", "memory_search", { query: "baterias" }),
				call("c2", "memory_search", { query: "baterias" }),
				call("c3", "memory_search", { query: "baterias" }),
				text("Resumo do mercado de baterias, com os preços de 2025."),
			],
			{ consumeSteerInputs: async () => (++calls === 2 ? [{ id: "in-mid", content: NOTE, mode: "join" }] : []) },
			PLAIN_OBJECTIVE,
		);
		const result = await execute();
		expect(result.text).toContain("preços de 2025");
		// A mensagem chega no pedido seguinte, durante o run, como `user` (não como nota do runtime).
		const at = requests.findIndex((request) => request.some((m) => m.role === "user" && String(m.content).includes(NOTE)));
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(requests.length - 1);
		expect(appendedToolNotes(requests.at(-1)!).some((note) => note.includes(NOTE))).toBe(false);
		// Nenhuma mensagem de sistema nova depois que o run começou (só as do início).
		for (const request of requests) {
			const firstAssistant = request.findIndex((m) => m.role === "assistant");
			if (firstAssistant < 0) continue;
			expect(request.slice(firstAssistant).filter((m) => m.role === "system")).toEqual([]);
		}
	});
});
