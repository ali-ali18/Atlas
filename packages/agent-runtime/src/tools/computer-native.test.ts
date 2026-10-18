import { describe, expect, it } from "vitest";
import { NATIVE_COMPUTER_TOOL, translateNativeComputerAction } from "./computer-native.js";

describe("translateNativeComputerAction", () => {
	it("screenshot e clique viram as tools existentes", () => {
		expect(translateNativeComputerAction({ action: "screenshot" })).toEqual([{ name: "screenshot", args: {} }]);
		expect(translateNativeComputerAction({ action: "left_click", coordinate: [10, 20] })).toEqual([
			{ name: "click", args: { x: 10, y: 20 } },
		]);
		expect(translateNativeComputerAction({ action: "double_click", coordinate: [1, 2] })).toHaveLength(2);
	});
	it("scroll converte notches em pixels e direção em sinal", () => {
		expect(translateNativeComputerAction({ action: "scroll", scroll_direction: "up", scroll_amount: 2 })).toEqual([
			{ name: "scroll", args: { deltaX: 0, deltaY: -240 } },
		]);
		expect(translateNativeComputerAction({ action: "scroll", scroll_direction: "right" })[0]?.args).toEqual({
			deltaX: 360,
			deltaY: 0,
		});
	});
	it("zoom vira screenshot com region (x,y,w,h)", () => {
		expect(translateNativeComputerAction({ action: "zoom", region: [100, 50, 300, 250] })).toEqual([
			{ name: "screenshot", args: { region: { x: 100, y: 50, width: 200, height: 200 } } },
		]);
	});
	it("rejeita args inválidos e ações sem suporte com dica", () => {
		expect(() => translateNativeComputerAction({ action: "left_click" })).toThrow(/coordinate/);
		expect(() => translateNativeComputerAction({ action: "left_click", coordinate: [-1, 2] })).toThrow();
		expect(() => translateNativeComputerAction({ action: "type" })).toThrow(/text/);
		expect(() => translateNativeComputerAction({ action: "right_click", coordinate: [1, 1] })).toThrow(
			/não é suportada/,
		);
		expect(() => translateNativeComputerAction({ action: "zoom", region: [0, 0, 2, 2] })).toThrow();
		expect(() => translateNativeComputerAction({ action: "voar" })).toThrow(/inválida/);
	});
	it("wait limita a 20 s", () => {
		expect(translateNativeComputerAction({ action: "wait", duration: 99 })[0]?.args).toEqual({
			for: "stable",
			timeout_ms: 20000,
		});
	});
	it("todas as ações do schema são traduzíveis", () => {
		const props = NATIVE_COMPUTER_TOOL.function.parameters as {
			properties: { action: { enum: string[] } };
		};
		for (const action of props.properties.action.enum) {
			const args = { action, coordinate: [1, 1], text: "a", region: [0, 0, 20, 20] };
			expect(() => translateNativeComputerAction(args)).not.toThrow();
		}
	});
});
