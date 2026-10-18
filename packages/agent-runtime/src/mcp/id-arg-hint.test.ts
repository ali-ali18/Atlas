import { describe, expect, it } from "vitest";
import { CONNECTOR_ARGS_GUIDANCE } from "../computer-use.js";
import { idArgNotFoundHint } from "./id-arg-hint.js";

const schema = {
	type: "object",
	properties: {
		sub_issue_id: { type: "integer", description: "The ID of the sub-issue. ID is not the same as the issue number." },
		issue_number: { type: "integer", description: "The number of the parent item" },
	},
};

describe("idArgNotFoundHint", () => {
	it("404 com *_id pequeno sugere o id interno", () => {
		const hint = idArgNotFoundHint("404 Not Found []", { issue_number: 12, sub_issue_id: 269 }, schema);
		expect(hint).toContain('"sub_issue_id"');
		expect(hint).toContain("Do not conclude the feature is unavailable");
	});

	it("usa a descrição do schema mesmo sem nome terminado em id", () => {
		const hint = idArgNotFoundHint("resource does not exist", { ref: "42" }, { properties: { ref: { description: "Internal ID, not the same as the number" } } });
		expect(hint).toContain('"ref"');
	});

	it("404 genérico sem id suspeito não gera dica", () => {
		expect(idArgNotFoundHint("404 Not Found", { issue_number: 12, query: "x" }, schema)).toBeNull();
	});

	it("id grande ou erro que não é 404 não gera dica", () => {
		expect(idArgNotFoundHint("404 Not Found", { sub_issue_id: 3_300_000_000 }, schema)).toBeNull();
		expect(idArgNotFoundHint("500 internal error", { sub_issue_id: 269 }, schema)).toBeNull();
	});
});

describe("regra de ids no prompt de conectores", () => {
	it("pede o id do resultado anterior, não o número exibido", () => {
		expect(CONNECTOR_ARGS_GUIDANCE).toContain("Ids vs numbers: for a parameter named *_id, use the resource's id from a previous result, not its display number or name.");
	});
});
