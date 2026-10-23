import { describe, expect, it } from "vitest";
import { applyComputerUseEventsToTranscript } from "./run-transcript.js";

describe("applyComputerUseEventsToTranscript", () => {
	it("reconstrói deltas do assistente", () => {
		const next = applyComputerUseEventsToTranscript(
			[{ id: "u1", kind: "user", text: "oi" }],
			[
				{ type: "assistant_delta", id: "a", delta: "hel" },
				{ type: "assistant_delta", id: "a", delta: "lo" },
			],
		);
		expect(next).toEqual([
			{ id: "u1", kind: "user", text: "oi" },
			{ id: "cu-a", kind: "assistant", text: "hello" },
		]);
	});

	it("eventos de input não fabricam bolhas — o modelo confirma", () => {
		const next = applyComputerUseEventsToTranscript(
			[{ id: "u1", kind: "user", text: "quero com 24gb" }],
			[
				{
					type: "input_received",
					inputId: "in-1",
					mode: "steer",
					content: "quero com 24gb",
				},
				{
					type: "input_consumed",
					inputId: "in-1",
					mode: "steer",
					content: "quero com 24gb",
				},
			],
		);
		expect(next).toEqual([{ id: "u1", kind: "user", text: "quero com 24gb" }]);
	});

	it("diagnóstico de loop vira bolha do assistente, não some no replay", () => {
		const next = applyComputerUseEventsToTranscript(
			[{ id: "u1", kind: "user", text: "clica" }],
			[
				{
					type: "error",
					error:
						"Travei repetindo `click` 3 vezes com o mesmo resultado, sem progresso.",
				},
			],
		);
		expect(next[1]).toEqual({
			id: "cu-run-error",
			kind: "assistant",
			text: "Travei repetindo `click` 3 vezes com o mesmo resultado, sem progresso.",
		});
	});

	it("rascunho revisado continua visível, recolhido com o motivo, e a versão nova vem depois", () => {
		const next = applyComputerUseEventsToTranscript([], [
			{ type: "assistant_delta", id: "t-step-1", delta: "Pedi pro Bobinho, te aviso." },
			{ type: "assistant_discard", id: "t-step-1", reason: "missing_file" },
			{ type: "assistant_delta", id: "t-step-2", delta: "Ainda não há arquivo." },
		]);
		expect(next).toEqual([
			{ id: "cu-t-step-1", kind: "assistant", text: "Pedi pro Bobinho, te aviso.", revised: "missing_file" },
			{ id: "cu-t-step-2", kind: "assistant", text: "Ainda não há arquivo." },
		]);
	});

	it("descarte com id não mexe no balão de outro passo (passo sem texto)", () => {
		const next = applyComputerUseEventsToTranscript([], [
			{ type: "assistant_delta", id: "t-step-1", delta: "Vou abrir o AVA." },
			{ type: "assistant_discard", id: "t-step-2", reason: "timeout" },
		]);
		expect(next).toEqual([{ id: "cu-t-step-1", kind: "assistant", text: "Vou abrir o AVA." }]);
	});

	it("só a fala repetida sai da tela", () => {
		const next = applyComputerUseEventsToTranscript([], [
			{ type: "assistant_delta", id: "t-step-1", delta: "Vou abrir o AVA." },
			{ type: "assistant_discard", id: "t-step-1", reason: "duplicate" },
		]);
		expect(next[0]?.text).toBe("");
		expect(next[0]?.revised).toBeUndefined();
	});

	it("evento antigo sem motivo vira rascunho revisado genérico (nunca some calado)", () => {
		const next = applyComputerUseEventsToTranscript([], [
			{ type: "assistant_delta", id: "a", delta: "Rascunho." },
			{ type: "assistant_discard" },
		]);
		expect(next[0]).toMatchObject({ text: "Rascunho.", revised: "revised" });
	});
});
