import { describe, expect, it, vi } from "vitest";
import type { JevAsk, JevComplete } from "./jev/decide.js";
import { createMemoryJudge, memoryJudgeFor, reviewMemoryEntries, type MemoryGateLayers } from "./memory-gate.js";

const layers: MemoryGateLayers = {
	user: [],
	memory: [
		{ id: "e1", content: "Cliente Silva paga todo dia 10 por boleto" },
		{ id: "e2", content: "Prefere relatórios em planilha" },
	],
};
const quiet = { log: () => undefined };

/** Jev falso: responde `useful_N`/`overlap_N` pelo mapa, 1 para o que não estiver nele. */
function jev(answers: Record<string, number>): JevAsk {
	return async ({ questions }) => ({ model: "fake", answers: Object.fromEntries(Object.keys(questions).map((key) => [key, answers[key] ?? (key.startsWith("overlap") || key.startsWith("redundant") ? 0 : 1)])) });
}
const reply = (value: unknown): JevComplete => async () => JSON.stringify(value);

describe("porteiro da memória: Jev classifica", () => {
	it("salva o que muda o futuro, descarta o que não muda e registra o motivo no log", async () => {
		const log = vi.fn();
		const judge = createMemoryJudge({ ask: jev({ useful_1: 0.1 }), log });
		const out = await judge({
			candidates: [
				{ content: "Prefere respostas curtas", target: "user" },
				{ content: "Hoje a reunião foi remarcada", target: "memory" },
			],
			existing: layers,
		});
		expect(out).toEqual([{ action: "save" }, { action: "discard", reason: "não muda o que o bot faria depois" }]);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[memory\.gate\] discard via=jev target=memory reason=não muda/));
	});

	it("tudo num só pedido ao Jev (um lote), com uma pergunta de utilidade por fato", async () => {
		const ask = vi.fn(jev({}));
		await createMemoryJudge({ ask, ...quiet })({ candidates: [{ content: "a", target: "memory" }, { content: "b", target: "memory" }, { content: "c", target: "user" }], existing: layers });
		expect(ask).toHaveBeenCalledTimes(1);
		expect(Object.keys(ask.mock.calls[0]![0].questions).sort()).toEqual(["overlap_0", "overlap_1", "overlap_2", "useful_0", "useful_1", "useful_2"]);
	});

	it("sobreposição: o Jev marca, o modelo de manutenção escreve o texto fundido", async () => {
		const complete = vi.fn(reply({ merges: [{ n: 0, entry: 0, duplicate: false, content: "Cliente Silva paga todo dia 10 por boleto ou pix" }] }));
		const out = await createMemoryJudge({ ask: jev({ overlap_0: 0.9 }), complete, ...quiet })({
			candidates: [{ content: "Silva também aceita pix", target: "memory" }],
			existing: layers,
		});
		expect(out).toEqual([{ action: "merge", entryId: "e1", oldText: "Cliente Silva paga todo dia 10 por boleto", content: "Cliente Silva paga todo dia 10 por boleto ou pix" }]);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("duplicata pura vira descarte; entrada inexistente na resposta do escritor salva como está", async () => {
		const dup = await createMemoryJudge({ ask: jev({ overlap_0: 0.9 }), complete: reply({ merges: [{ n: 0, entry: 0, duplicate: true, content: "" }] }), ...quiet })({
			candidates: [{ content: "Silva paga dia 10 de boleto", target: "memory" }],
			existing: layers,
		});
		expect(dup).toEqual([{ action: "discard", reason: "já registrado" }]);
		const bad = await createMemoryJudge({ ask: jev({ overlap_0: 0.9 }), complete: reply({ merges: [{ n: 0, entry: 9, duplicate: false, content: "x" }] }), ...quiet })({
			candidates: [{ content: "algo", target: "memory" }],
			existing: layers,
		});
		expect(bad).toEqual([{ action: "save" }]);
	});

	it("sem escritor, sobreposição salva como está; replace nunca funde", async () => {
		const noWriter = await createMemoryJudge({ ask: jev({ overlap_0: 0.95 }), ...quiet })({ candidates: [{ content: "algo", target: "memory" }], existing: layers });
		expect(noWriter).toEqual([{ action: "save" }]);
		const complete = vi.fn(reply({ merges: [] }));
		const replace = await createMemoryJudge({ ask: jev({ overlap_0: 0.95 }), complete, ...quiet })({ candidates: [{ content: "atualizado", target: "memory", replaces: true }], existing: layers });
		expect(replace).toEqual([{ action: "save" }]);
		expect(complete).not.toHaveBeenCalled();
	});
});

describe("porteiro da memória: modelo de manutenção e fail-open", () => {
	it("sem Jev, o modelo de manutenção julga o lote inteiro", async () => {
		const complete = vi.fn(
			reply({
				verdicts: [
					{ n: 0, action: "discard", reason: "tarefa já concluída" },
					{ n: 1, action: "merge", entry: 1, content: "Prefere relatórios em planilha (xlsx)" },
					{ n: 2, action: "save" },
				],
			}),
		);
		const out = await createMemoryJudge({ complete, ...quiet })({
			candidates: [
				{ content: "Enviei o relatório", target: "memory" },
				{ content: "Planilha em xlsx", target: "memory" },
				{ content: "Mora em Curitiba", target: "user" },
			],
			existing: layers,
		});
		expect(complete).toHaveBeenCalledTimes(1);
		expect(out).toEqual([{ action: "discard", reason: "tarefa já concluída" }, { action: "merge", entryId: "e2", oldText: "Prefere relatórios em planilha", content: "Prefere relatórios em planilha (xlsx)" }, { action: "save" }]);
	});

	it("Jev com erro cai no modelo de manutenção", async () => {
		const ask: JevAsk = async () => {
			throw new Error("boom");
		};
		const out = await createMemoryJudge({ ask, complete: reply({ verdicts: [{ n: 0, action: "discard", reason: "trivial" }] }), ...quiet })({ candidates: [{ content: "x", target: "memory" }], existing: layers });
		expect(out).toEqual([{ action: "discard", reason: "trivial" }]);
	});

	it("Jev com resposta fora de [0,1] também cai no modelo", async () => {
		const ask: JevAsk = async ({ questions }) => ({ model: "m", answers: Object.fromEntries(Object.keys(questions).map((key) => [key, 7])) });
		const out = await createMemoryJudge({ ask, complete: reply({ verdicts: [{ n: 0, action: "discard", reason: "trivial" }] }), ...quiet })({ candidates: [{ content: "x", target: "memory" }], existing: layers });
		expect(out).toEqual([{ action: "discard", reason: "trivial" }]);
	});

	it("tudo falhando (erro, JSON ruim, prazo) salva e avisa; sem nenhum caminho salva em silêncio", async () => {
		const log = vi.fn();
		const failingAsk: JevAsk = async () => {
			throw new Error("down");
		};
		const broken: JevComplete = async () => "isto não é json";
		const candidates = [{ content: "x", target: "memory" as const }];
		expect(await createMemoryJudge({ ask: failingAsk, complete: broken, log })({ candidates, existing: layers })).toEqual([{ action: "save" }]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("warn unavailable"));
		const slow: JevAsk = () => new Promise(() => undefined);
		expect(await createMemoryJudge({ ask: slow, jevTimeoutMs: 5, log })({ candidates, existing: layers })).toEqual([{ action: "save" }]);
		expect(await createMemoryJudge({})({ candidates, existing: layers })).toEqual([{ action: "save" }]);
	});

	it("veredito faltando para um fato salva esse fato", async () => {
		const out = await createMemoryJudge({ complete: reply({ verdicts: [{ n: 1, action: "discard", reason: "trivial" }] }), ...quiet })({
			candidates: [{ content: "a", target: "memory" }, { content: "b", target: "memory" }],
			existing: layers,
		});
		expect(out).toEqual([{ action: "save" }, { action: "discard", reason: "trivial" }]);
	});
});

describe("memoryJudgeFor (Jev do run)", () => {
	it("modo memory em on usa o Jev; desligado usa só o texto do revisor; sem nada, não há porteiro", async () => {
		const ask = vi.fn(jev({ useful_0: 0 }));
		const on = memoryJudgeFor({ ask, modes: { memory: "on" } });
		expect(await on!({ candidates: [{ content: "x", target: "memory" }], existing: layers })).toEqual([{ action: "discard", reason: "não muda o que o bot faria depois" }]);
		const off = memoryJudgeFor({ ask, modes: { memory: "off" }, complete: reply({ verdicts: [{ n: 0, action: "save" }] }) });
		ask.mockClear();
		expect(await off!({ candidates: [{ content: "x", target: "memory" }], existing: layers })).toEqual([{ action: "save" }]);
		expect(ask).not.toHaveBeenCalled();
		expect(memoryJudgeFor({ ask, modes: { memory: "off" } })).toBeUndefined();
		expect(memoryJudgeFor(undefined)).toBeUndefined();
	});
});

describe("limpeza das memórias existentes (só sugere)", () => {
	const entries = [
		{ id: "a", content: "Reunião de hoje remarcada para as 15h" },
		{ id: "b", content: "Prefere relatórios em planilha" },
		{ id: "c", content: "Gosta de relatórios em planilha xlsx" },
		{ id: "d", content: "Mora em Curitiba" },
	];

	it("Jev marca o inútil (apagar) e os repetidos; o modelo de manutenção escreve a fusão", async () => {
		const complete = vi.fn(reply({ merge: [{ entries: [1, 2], content: "Prefere relatórios em planilha (xlsx)", reason: "mesmo assunto" }] }));
		const drafts = await reviewMemoryEntries({ entries }, { ask: jev({ useful_0: 0.05, redundant_1: 0.9, redundant_2: 0.9 }), complete, ...quiet });
		expect(drafts).toEqual([
			{ kind: "delete", entryIds: ["a"], reason: "não muda o que o bot faria depois" },
			{ kind: "merge", entryIds: ["b", "c"], content: "Prefere relatórios em planilha (xlsx)", reason: "mesmo assunto" },
		]);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("sem Jev, o modelo faz tudo; uma entrada nunca aparece em duas sugestões; índice inválido é ignorado", async () => {
		const drafts = await reviewMemoryEntries(
			{ entries },
			{
				complete: reply({
					delete: [{ n: 0, reason: "tarefa encerrada" }, { n: 99, reason: "x" }],
					merge: [{ entries: [0, 1], content: "não pode" }, { entries: [1, 2], content: "Prefere planilha xlsx", reason: "repetidas" }],
				}),
				...quiet,
			},
		);
		expect(drafts).toEqual([
			{ kind: "delete", entryIds: ["a"], reason: "tarefa encerrada" },
			{ kind: "merge", entryIds: ["b", "c"], content: "Prefere planilha xlsx", reason: "repetidas" },
		]);
	});

	it("Jev com erro cai no modelo; sem nenhum caminho lança (o job mostra o erro)", async () => {
		const down: JevAsk = async () => {
			throw new Error("down");
		};
		const drafts = await reviewMemoryEntries({ entries }, { ask: down, complete: reply({ delete: [{ n: 3, reason: "vago" }] }), ...quiet });
		expect(drafts).toEqual([{ kind: "delete", entryIds: ["d"], reason: "vago" }]);
		await expect(reviewMemoryEntries({ entries }, {})).rejects.toThrow();
		expect(await reviewMemoryEntries({ entries: [] }, {})).toEqual([]);
	});
});
