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
});
