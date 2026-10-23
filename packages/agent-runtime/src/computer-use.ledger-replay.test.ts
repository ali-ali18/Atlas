import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { parseTaskState } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { jevSaying } from "./jev/test-support.js";

/**
 * V3/V3b — replay com LLM mockado do caso real: "leia as 9 semanas da disciplina
 * e gere um PDF". O modelo declara os itens, lê alguns, tenta entregar cedo e
 * pedir o conteúdo ao usuário: o portão devolve a lista de pendentes.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { runId: string; kind: string; bytes: Uint8Array; mime: string; meta?: object }) => ({
		id: "art-1",
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: input.runId,
		conversationId: "conv-ledger",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const call = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

type Message = CompleteChatWithToolsParams["messages"][number];
type Ev = Record<string, unknown> & { type: string };
type Request = { index: number; offered: string[]; messages: Message[]; toolChoice?: unknown };
type Driver = (ctx: { index: number; messages: Message[]; offered: string[]; toolChoice: unknown }) => CompleteChatWithToolsResult;

const SCOPE = "Course X";
const WEEKS = Array.from({ length: 9 }, (_, i) => ({ label: `Week ${i + 1}`, scope: SCOPE }));
const readPage = (id: string) => call(id, "browser_text", {});
const done = (id: string, n: number) => call(id, "track_items", { action: "update", id: String(n), status: "done", evidence: `read week ${n}` });
const setItems = (id: string) => call(id, "track_items", { action: "set", items: WEEKS, facts_given: [`course: ${SCOPE}`], plan: ["open the course", "read each week", "write the pdf"] });

async function run(input: {
	driver: Driver;
	message?: string;
	costPerCall?: number;
	maxSteps?: number;
	jev?: ReturnType<typeof jevSaying>;
	priorTaskLedger?: unknown;
	checkpoint?: AgentRunCheckpoint;
	pageText?: (n: number) => string;
}) {
	const requests: Request[] = [];
	const events: Ev[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	let pages = 0;
	const manager = {
		execBrowserText: vi.fn(async () => ({
			url: `https://lms.example.test/week-${pages}`,
			title: "Page",
			text: input.pageText ? input.pageText(pages++) : `contents of page ${pages++}`,
			mode: "page" as const,
			offset: 0,
			totalLength: 100,
			truncated: false,
			scrollY: 0,
			scrollHeight: 100,
		})),
	} as unknown as SandboxManager;
	let decision = 0;
	let error: unknown;
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	try {
		result = await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-ledger",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-ledger",
			origin: "chat",
			contextEconomy: false,
			jev: input.jev ?? jevSaying({ wants_file: 0.95 }),
			messages: [{ role: "user", content: input.message ?? "read all 9 weeks of course X and produce a PDF" }],
			maxSteps: input.maxSteps ?? 80,
			budget: { maxCostUsd: 1 },
			priorTaskLedger: input.priorTaskLedger,
			restoredCheckpoint: input.checkpoint,
			onCheckpoint: async (checkpoint: AgentRunCheckpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
			},
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (params) => {
				const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
				const offered = params.tools.map((tool) => tool.function.name);
				const index = decision++;
				requests.push({ index, offered, messages, toolChoice: params.toolChoice });
				return { ...input.driver({ index, messages, offered, toolChoice: params.toolChoice }), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: input.costPerCall ?? 0.01 } };
			},
		} as never);
	} catch (caught) {
		error = caught;
	}
	return { result, error, requests, events, checkpoints, manager };
}

const text = (message: Message) => (typeof message.content === "string" ? message.content : "");
const systemTexts = (request: Request) => request.messages.filter((m) => m.role === "system").map(text);
const itemsLayer = (request: Request) => systemTexts(request).find((t) => t.startsWith("Items:")) ?? null;
const toolResults = (events: Ev[], name: string) => events.filter((e) => e.type === "tool_result" && e.name === name) as Array<Ev & { ok: boolean; summary: string }>;
const fileEvents = (events: Ev[]) => events.filter((e) => e.type === "file");
const lastTaskState = (checkpoints: AgentRunCheckpoint[]) => parseTaskState(checkpoints.at(-1)?.taskState);

describe("replay: 9 semanas de uma disciplina", () => {
	it("barra o create_file com 2/9, barra o pedido ao usuário, e só entrega com 9/9", async () => {
		const trace: string[] = [];
		const { result, error, requests, events, checkpoints } = await run({
			driver: ({ index }) => {
				if (index === 0) return turn(setItems("set"));
				if (index === 1) return turn(readPage("r1"), done("d1", 1));
				if (index === 2) return turn(readPage("r2"), done("d2", 2));
				if (index === 3) {
					trace.push("create_file com 2/9");
					return turn(call("early", "create_file", { filename: "weeks.md", content: "# Weeks\n\nOnly two weeks." }));
				}
				if (index === 4) {
					trace.push("pede ao usuário");
					return say("I could not open the weeks. Please paste the content of each week here.");
				}
				if (index >= 5 && index <= 11) {
					const week = index - 2;
					return turn(readPage(`r${week}`), done(`d${week}`, week));
				}
				if (index === 12) return turn(call("final", "create_file", { filename: "weeks.md", content: "# Weeks\n\nAll nine weeks." }));
				return say("Here is the PDF with the 9 weeks.");
			},
		});
		expect(error).toBeUndefined();
		expect(trace).toEqual(["create_file com 2/9", "pede ao usuário"]);

		// create_file barrado: erro honesto com a lista dos pendentes, e nenhum arquivo foi criado nesse ponto
		const createResults = toolResults(events, "create_file");
		expect(createResults[0]).toMatchObject({ ok: false });
		expect(createResults[0]!.summary).toContain("File not created.");
		expect(createResults[0]!.summary).toContain("7 items are still open");
		expect(createResults[0]!.summary).toContain('3 "Week 3" (Course X)');
		expect(createResults[0]!.summary).toContain("do not ask the user to paste it");
		expect(createResults[1]).toMatchObject({ ok: true });
		expect(fileEvents(events)).toHaveLength(1);

		// resposta pedindo conteúdo ao usuário: interceptada (balão retirado) e a nota volta ao modelo
		const afterAsk = requests[5]!;
		expect(events.some((e) => e.type === "assistant_discard")).toBe(true);
		expect(systemTexts(afterAsk).some((t) => t.includes("7 items are still open") && t.includes("Continue with the next open item"))).toBe(true);

		// a camada de itens e o item pai estão em todo passo, com o progresso certo
		expect(itemsLayer(requests[1]!)).toContain("Items: 0/9 done.");
		expect(itemsLayer(requests[3]!)).toContain("Items: 2/9 done.");
		expect(itemsLayer(requests[3]!)).toContain('Now: item 3 "Week 3" (parent: Course X)');
		expect(itemsLayer(requests[12]!)).toContain("Items: 9/9 done.");
		for (const request of requests.slice(1, 13)) expect(itemsLayer(request)!.length).toBeLessThanOrEqual(600);

		// termina com a resposta final, sem pedir nada ao usuário
		expect(result?.text).toBe("Here is the PDF with the 9 weeks.");
		const ledger = lastTaskState(checkpoints)?.ledger;
		expect(ledger?.items.filter((i) => i.status === "done")).toHaveLength(9);
		expect(ledger?.gateBlocks).toBe(2);
		expect(ledger?.plan).toContain("read each week");
	});

	it("a camada de itens não vai ao modelo quando não há lista", async () => {
		const { requests } = await run({
			driver: ({ index }) => (index === 0 ? turn(readPage("r1")) : say("done")),
		});
		expect(requests.every((request) => itemsLayer(request) === null)).toBe(true);
		expect(requests[0]!.offered).toContain("track_items");
	});

	it("com 80% do orçamento entrega o parcial e o arquivo lista as lacunas; a parcial fica no checkpoint", async () => {
		const { events, requests, checkpoints, result, error } = await run({
			costPerCall: 0.09,
			driver: ({ index }) => {
				if (index === 0) return turn(setItems("set"));
				if (index === 1) return turn(readPage("r1"), done("d1", 1));
				if (index === 2) return turn(readPage("r2"), done("d2", 2));
				if (index === 3) return turn(call("early", "create_file", { filename: "weeks.md", content: "# Weeks\n\nTwo weeks." }));
				if (index === 4) return say("Please paste the other weeks.");
				if (index >= 5 && index <= 8) return turn(readPage(`r${index}`));
				if (index === 9) return turn(call("late", "create_file", { filename: "weeks.md", content: "# Weeks\n\nTwo weeks.\n\n## Gaps\n\nWeeks 3-9 were not read." }));
				return say("Partial PDF delivered: weeks 3 to 9 are missing because they were not reached.");
			},
		});
		const createResults = toolResults(events, "create_file");
		expect(createResults.map((r) => r.ok)).toEqual([false, true]);
		expect(fileEvents(events)).toHaveLength(1);
		// a 28% barra; a 84% (9 chamadas de 3/32) libera e a nota pede a verdade sobre as lacunas
		const lateRequest = requests[9]!;
		expect(systemTexts(lateRequest).some((t) => t.includes("Some items are still open. Deliver what you have now"))).toBe(true);
		expect(result?.text).toContain("Partial PDF delivered");
		const ledger = lastTaskState(checkpoints)?.ledger;
		expect(ledger?.partial?.missing.map((m) => m.id)).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
		expect(ledger?.partial?.missing[0]!.reason).toBe("not reached before delivery");
	});

	it("recusa a resposta final uma vez só: a nota diz como fechar, e a resposta seguinte sai como está", async () => {
		const { result, events, requests, checkpoints } = await run({
			driver: ({ index }) => {
				if (index === 0) return turn(setItems("set"));
				if (index === 1) return say("attempt 1: please paste the weeks.");
				return say("I could not read the weeks; weeks 1 to 9 are missing.");
			},
		});
		expect(events.filter((e) => e.type === "assistant_discard" && e.reason === "items_open")).toHaveLength(1);
		const note = systemTexts(requests[2]!).find((t) => t.includes("Continue with the next open item"))!;
		expect(note).toContain("track_items update with status done");
		expect(note).toContain("name each missing item and the real reason");
		expect(note).toContain("your next reply goes to the user as is");
		expect(result?.text).toBe("I could not read the weeks; weeks 1 to 9 are missing.");
		// a lacuna fica registrada (a UI mostra o que faltou)
		expect(lastTaskState(checkpoints)?.ledger?.partial?.missing).toHaveLength(9);
	});

	it("tarefa de vários itens (Jev) exige a lista antes de entregar", async () => {
		const { requests, events, result } = await run({
			jev: jevSaying({ wants_file: 0.95, multi_item: 0.95 }),
			driver: ({ index }) => {
				if (index === 0) return say("The weeks are interesting. Here is a summary.");
				if (index === 1) return turn(setItems("set"));
				if (index <= 10) return turn(readPage(`r${index}`), done(`d${index}`, index - 1));
				return say("All weeks done.");
			},
		});
		expect(requests[0]!.messages.some((m) => m.role === "system" && text(m).includes("Start by declaring them with track_items"))).toBe(true);
		expect(events.some((e) => e.type === "assistant_discard")).toBe(true);
		expect(systemTexts(requests[1]!).some((t) => t.includes("Declare them first with track_items"))).toBe(true);
		expect(result?.text).toBe("All weeks done.");
	});
});

describe("replay: estagnação", () => {
	it("sem progresso: replaneja duas vezes e fecha com parcial honesta listando o que falta", async () => {
		const { requests, result, checkpoints, error } = await run({
			jev: jevSaying({}),
			pageText: () => "the same page again",
			driver: ({ index, toolChoice }) => {
				if (index === 0) return turn(setItems("set"));
				if (index === 1) return turn(readPage("r1"), done("d1", 1));
				// fechamento do ledger: o loop corta as tools (toolChoice none) e o modelo só responde
				if (toolChoice === "none") return say("Partial result: weeks 2 to 9 could not be reached; the course page stopped changing.");
				return turn(call(`click-${index}`, "browser_text", {}));
			},
		});
		expect(error).toBeUndefined();
		const notes = systemTexts(requests.at(-1)!).filter((t) => t.startsWith("[Execution note]"));
		const unique = notes;
		expect(unique.filter((t) => t.includes("Update the plan"))).toHaveLength(2);
		expect(unique.filter((t) => t.includes("Stopping with a partial result"))).toHaveLength(1);
		const stop = unique.find((t) => t.includes("Stopping with a partial result"))!;
		expect(stop).toContain("Done: 1.");
		expect(stop).toContain('2 "Week 2"');
		expect(stop).toContain("Do not ask the user for content you can reach yourself");
		// o aviso genérico de estagnação não disputa com o ledger de itens
		expect(notes.some((t) => t.includes("Change your approach"))).toBe(false);
		expect(result?.text).toContain("Partial result");
		const ledger = lastTaskState(checkpoints)?.ledger;
		expect(ledger?.replans).toBe(2);
		expect(ledger?.stopped).toBe(true);
		expect(ledger?.partial?.missing.map((m) => m.id)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
		// a resposta parcial não é barrada pelo portão (sem tools para continuar)
		expect(requests.at(-1)!.toolChoice).toBe("none");
	});
});

describe("replay: continuação entre runs", () => {
	const priorLedger = () => ({
		v: 1,
		items: WEEKS.map((week, i) => ({ id: String(i + 1), label: week.label, scope: week.scope, status: i < 2 ? "done" : "pending", ...(i < 2 ? { evidence: `read week ${i + 1}` } : {}) })),
		factsGiven: [`course: ${SCOPE}`],
		plan: ["read each week"],
		stalled: 2,
		replans: 1,
		gateBlocks: 2,
	});

	it("'ent leia tudo' retoma os itens pendentes: o ledger anterior é oferecido e, adotado, volta a segurar a entrega", async () => {
		const { requests, events, result, checkpoints } = await run({
			message: "ent leia tudo uai",
			priorTaskLedger: priorLedger(),
			driver: ({ index }) => {
				if (index === 0) return turn(call("adopt", "track_items", { action: "update", id: "3", status: "in_progress" }));
				if (index <= 7) {
					const week = index + 2;
					return turn(readPage(`r${week}`), done(`d${week}`, week));
				}
				if (index === 8) return say("Here is everything.");
				return say("Here is everything.");
			},
		});
		expect(itemsLayer(requests[0]!)).toContain("earlier run");
		expect(itemsLayer(requests[0]!)).toContain('3 "Week 3" (Course X)');
		expect(itemsLayer(requests[1]!)).toContain('Now: item 3 "Week 3" (parent: Course X)');
		expect(itemsLayer(requests[1]!)).toContain("Items: 2/9 done.");
		expect(events.filter((e) => e.type === "assistant_discard" && e.reason === "items_open")).toHaveLength(0);
		expect(result?.text).toBe("Here is everything.");
		expect(lastTaskState(checkpoints)?.ledger?.items.filter((i) => i.status === "done")).toHaveLength(9);
		// os contadores do run anterior não vazam
		expect(lastTaskState(checkpoints)?.ledger?.replans).toBe(0);
	});

	const proposta = () => ({
		v: 1,
		items: ["Item A", "Item B", "Item C", "Item D"].map((label, i) => ({ id: String(i + 1), label, scope: "proposta 3801", status: "pending" })),
		stalled: 0,
		replans: 0,
		gateBlocks: 0,
	});
	const PRICE = "Canela rama: R$ 12,90 o kg.";

	it("pedido novo com checklist antigo aberto: a resposta com o preço sai intacta, sem descarte, e o checklist não é regravado", async () => {
		const { requests, events, result, checkpoints, error } = await run({
			message: "Preço canela rama",
			jev: jevSaying({}),
			priorTaskLedger: proposta(),
			driver: ({ index }) => (index === 0 ? turn(readPage("price")) : say(PRICE)),
		});
		expect(error).toBeUndefined();
		expect(events.filter((e) => e.type === "assistant_discard")).toHaveLength(0);
		expect(result?.text).toBe(PRICE);
		// o modelo vê a oferta com a instrução de responder primeiro e nunca limpar por conta própria
		expect(itemsLayer(requests[0]!)).toContain("Answer the user's current request fully first");
		expect(itemsLayer(requests[0]!)).toContain('1 "Item A" (proposta 3801)');
		expect(requests).toHaveLength(2);
		// o run não adotou o checklist: o checkpoint não o grava, então o turno seguinte não o recebe de novo
		expect(lastTaskState(checkpoints)?.ledger).toBeUndefined();
	});

	it("o modelo limpa a lista antiga por conta própria e responde: nada de descarte, e o ledger não volta", async () => {
		const { events, result, checkpoints } = await run({
			message: "Preço canela rama",
			jev: jevSaying({}),
			priorTaskLedger: proposta(),
			driver: ({ index }) => (index === 0 ? turn(call("clear", "track_items", { action: "clear" }), readPage("price")) : say(PRICE)),
		});
		expect(events.filter((e) => e.type === "assistant_discard")).toHaveLength(0);
		expect(result?.text).toBe(PRICE);
		expect(lastTaskState(checkpoints)?.ledger).toBeUndefined();
	});

	it("checklist herdado com 2 itens: fechar só um não torna o outro obrigação (cenário B, sem descarte)", async () => {
		const prior = { ...proposta(), items: proposta().items.slice(0, 2) };
		const FINAL = "Item A conferido: R$ 12,90.";
		const { events, result, checkpoints } = await run({
			message: "confere o item A da proposta",
			jev: jevSaying({}),
			priorTaskLedger: prior,
			driver: ({ index }) => (index === 0 ? turn(call("u1", "track_items", { action: "update", id: "1", status: "done", evidence: "R$ 12,90" })) : say(FINAL)),
		});
		expect(events.filter((e) => e.type === "assistant_discard")).toHaveLength(0);
		expect(result?.text).toBe(FINAL);
		const ledger = lastTaskState(checkpoints)?.ledger;
		expect(ledger?.carry).toBe("adopted");
		expect(ledger?.items.find((item) => item.id === "2")).toMatchObject({ status: "pending", carried: true });
	});

	it("checklist adotado no mesmo run continua persistindo", async () => {
		const { checkpoints } = await run({
			message: "continue a proposta 3801",
			priorTaskLedger: proposta(),
			driver: ({ index }) => (index === 0 ? turn(call("adopt", "track_items", { action: "update", id: "1", status: "in_progress" })) : say("ainda faltam itens")),
			maxSteps: 3,
		});
		expect(lastTaskState(checkpoints)?.ledger?.carry).toBe("adopted");
	});

	it("rascunho retirado pelo portão do run atual: o modelo é avisado de que o usuário NÃO o viu", async () => {
		const { requests, events } = await run({
			driver: ({ index }) => {
				if (index === 0) return turn(setItems("set"));
				if (index === 1) return say("Here is the PDF with the 9 weeks.");
				return say("done");
			},
			maxSteps: 4,
		});
		expect(events.some((e) => e.type === "assistant_discard")).toBe(true);
		const note = systemTexts(requests[2]!).find((t) => t.includes("Continue with the next open item"));
		expect(note).toContain("The user did NOT see your previous reply");
	});
});
