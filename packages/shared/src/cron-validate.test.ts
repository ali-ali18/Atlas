import { describe, expect, it } from "vitest";
import { validateCronExpression } from "./cron-validate.js";

describe("validateCronExpression", () => {
	it("aceita o que o agendador roda: listas, faixas, passos, nomes e 7 como domingo", () => {
		for (const ok of ["0 9 * * 1-5", "*/5 * * * *", "0 8 1 * *", "15,45 9-17 * * mon-fri", "0 0 * jan,jul sun", "0 0 * * 7", "5 4 * * *", "0 */2 * * *", "10-50/10 * * * *"]) {
			expect(validateCronExpression(ok), ok).toEqual({ ok: true });
		}
	});
	it("recusa campo fora da faixa, passo zero, faixa invertida, símbolos que o agendador não entende e número errado de campos", () => {
		for (const bad of ["a b c d e", "61 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "30-10 * * * *", "0 0 ? * *", "0 0 L * *", "0 0 * * 1#2", "0 9 * *", "0 0 9 * * *", "0,, 9 * * *", "-1 * * * *"]) {
			const out = validateCronExpression(bad);
			expect(out.ok, bad).toBe(false);
		}
	});
	it("recusa o que roda mais vezes do que o intervalo mínimo do produto (5 min), sem mexer nesse mínimo", () => {
		for (const bad of ["* * * * *", "*/2 * * * *", "0,1 * * * *", "0,3 9 * * *", "58,2 * * * *"]) {
			const out = validateCronExpression(bad);
			expect(out.ok, bad).toBe(false);
			expect((out as { reason: string }).reason).toMatch(/every 5 minutes/);
		}
		for (const ok of ["*/5 * * * *", "0,5 * * * *", "0 * * * *", "58,3 9 * * *", "0,30 * * * *", "59 23 * * *"]) expect(validateCronExpression(ok), ok).toEqual({ ok: true });
	});
});
