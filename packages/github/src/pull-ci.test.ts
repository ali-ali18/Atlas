import { describe, expect, it } from "vitest";
import { cleanJobLog, jobLogErrors, tailJobLog } from "./pull-ci.js";

const RAW = ["2026-11-09T10:00:00.000Z \u001b[32mok\u001b[0m", "2026-11-09T10:00:01Z ##[error]Process completed with exit code 1.", "2026-11-09T10:00:02Z ##[error]Process completed with exit code 1.", "fim"].join("\r\n");

describe("log de job do Actions", () => {
	it("cleanJobLog tira hora e ANSI; jobLogErrors junta as linhas ##[error] sem repetir", () => {
		const cleaned = cleanJobLog(RAW);
		expect(cleaned).toBe("ok\n##[error]Process completed with exit code 1.\n##[error]Process completed with exit code 1.\nfim");
		expect(jobLogErrors(cleaned)).toEqual(["Process completed with exit code 1."]);
	});

	it("tailJobLog segue igual: erros anotados no topo e o fim do log", () => {
		expect(tailJobLog(RAW)).toBe("Erros anotados:\nProcess completed with exit code 1.\n\nok\n##[error]Process completed with exit code 1.\n##[error]Process completed with exit code 1.\nfim");
		expect(tailJobLog(`${"x".repeat(50)}\nfim`, 10)).toContain("[início do log omitido]");
	});
});
