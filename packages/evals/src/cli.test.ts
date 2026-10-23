import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli.js";
import { callIdFromKey } from "./environment.js";

describe("utilidades do runner", () => {
	it("id da chamada a partir da chave de idempotência do runtime", () => {
		expect(callIdFromKey("eval-x-0-abc:2:mock_3:propose_routine", ["mock_1", "mock_3"])).toBe("mock_3");
		expect(callIdFromKey("run:0:r0run_call_1:create_file", ["r0run_call_1"])).toBe("r0run_call_1");
		expect(callIdFromKey("run:0:other:create_file", ["mock_1"])).toBeUndefined();
	});

	it("argumentos da CLI: comando, flags com valor, booleanas e o '--' do pnpm", () => {
		expect(parseCliArgs(["--", "--models", "a,b", "--mock", "--repeat=3"])).toEqual({ command: "run", positional: [], flags: { models: "a,b", mock: true, repeat: "3" } });
		expect(parseCliArgs(["compare", "x", "y"])).toEqual({ command: "compare", positional: ["x", "y"], flags: {} });
		expect(parseCliArgs(["from-run", "--inspect", "i.json", "--out", "o.json"]).flags).toEqual({ inspect: "i.json", out: "o.json" });
	});
});
