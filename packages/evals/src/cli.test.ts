import { describe, expect, it } from "vitest";
import { main, parseCliArgs } from "./cli.js";
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
		expect(parseCliArgs(["--", "matrix", "--scenarios", "gold", "--estimate", "--engines", "v2,v1", "--simulate", "--max-usd", "2"])).toEqual({
			command: "matrix",
			positional: [],
			flags: { scenarios: "gold", estimate: true, engines: "v2,v1", simulate: true, "max-usd": "2" },
		});
		expect(parseCliArgs(["from-run", "--inspect", "i.json", "--out", "o.json"]).flags).toEqual({ inspect: "i.json", out: "o.json" });
	});
});

describe("flags booleanas (auditoria F0, S1)", () => {
	it("aceita só true/false com =; false desliga a flag", () => {
		expect(parseCliArgs(["matrix", "--simulate=true"]).flags).toEqual({ simulate: true });
		expect(parseCliArgs(["matrix", "--simulate=false"]).flags).toEqual({});
	});

	it.each(["--simulate=1", "--estimate=yes", "--mock=sim", "--simulate=", "--simulate=TRUE", "--help=0"])("%s é erro (antes caía no modo real)", (flag) => {
		expect(() => parseCliArgs(["matrix", flag])).toThrow(/booleana/);
	});

	it("--simulate e --estimate fora do matrix são erro; --mock só no run", async () => {
		await expect(main(["--simulate"])).rejects.toThrow(/só vale no comando matrix/);
		await expect(main(["run", "--estimate"])).rejects.toThrow(/só vale no comando matrix/);
		await expect(main(["list", "--simulate"])).rejects.toThrow(/só vale no comando matrix/);
		await expect(main(["matrix", "--mock"])).rejects.toThrow(/--simulate/);
	});

	it("valor inválido nem chega a carregar cenários nem a rede", async () => {
		await expect(main(["matrix", "--simulate=1", "--models", "anthropic/claude-haiku-5-5"])).rejects.toThrow(/Nada foi executado/);
	});
});
