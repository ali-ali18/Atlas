import { describe, expect, it } from "vitest";
import { analyzeMemoryHealth, doctorProposalId, doctorSummary, parseConflictFindings } from "./memory-doctor.js";

const now = new Date("2026-11-08T12:00:00Z");
const mem = (id: string, content: string, over: Partial<{ scope: string; updatedAt: string; validUntil: string | null }> = {}) => ({ id, scope: "owner", content, updatedAt: "2026-11-01T00:00:00Z", ...over });

describe("analyzeMemoryHealth", () => {
	it("acha repetidos e parecidos no mesmo escopo, mas não entre escopos", () => {
		const findings = analyzeMemoryHealth({
			memory: [
				mem("a", "Prefere reuniões curtas pela manhã com a equipe"),
				mem("b", "prefere reunioes curtas pela manha com a equipe!"),
				mem("c", "Prefere reuniões curtas pela manhã com a equipe de vendas", { scope: "bot" }),
				mem("d", "Mora em Curitiba"),
				mem("e", "Mora em Curitiba", { scope: "bot" }),
			],
			notes: [],
			now,
		});
		expect(findings.filter((f) => f.type === "duplicate").map((f) => f.ids)).toEqual([["a", "b"]]);
	});
	it("textos curtos só contam como repetidos se forem iguais", () => {
		const findings = analyzeMemoryHealth({ memory: [mem("a", "usa vim"), mem("b", "usa vim e tmux")], notes: [], now });
		expect(findings).toEqual([]);
	});
	it("aponta item vencido e item velho, e só propõe (reason em pt-BR)", () => {
		const findings = analyzeMemoryHealth({
			memory: [mem("a", "Viaja em dezembro", { validUntil: "2026-10-01T00:00:00Z" }), mem("b", "Gosta de chá", { updatedAt: "2026-01-01T00:00:00Z" }), mem("c", "Recente")],
			notes: [{ id: "n1", scope: "owner", title: "Velha", body: "x", updatedAt: "2025-01-01T00:00:00Z" }],
			now,
		});
		expect(findings.map((f) => `${f.type}:${f.subject}:${f.ids[0]}`)).toEqual(["stale:memory:a", "stale:memory:b", "stale:note:n1"]);
		expect(findings.every((f) => f.reason.length > 0)).toBe(true);
	});
	it("duplicata de notas considera título e corpo", () => {
		const findings = analyzeMemoryHealth({ memory: [], notes: [{ id: "n1", scope: "owner", title: "Lista", body: "pão e leite", updatedAt: "2026-11-01" }, { id: "n2", scope: "owner", title: "lista", body: "Pão e leite.", updatedAt: "2026-11-02" }], now });
		expect(findings).toEqual([{ type: "duplicate", subject: "note", ids: ["n1", "n2"], reason: "Os dois textos dizem a mesma coisa." }]);
	});
});

describe("conflitos do modelo", () => {
	const valid = { memory: new Set(["a", "b"]), note: new Set(["n1", "n2"]) };
	it("só aceita ids que o código mostrou, no conjunto certo", () => {
		const out = parseConflictFindings({ conflicts: [{ subject: "memory", ids: ["a", "b"], reason: "Um diz Curitiba, o outro Recife." }, { subject: "memory", ids: ["a", "zzz"], reason: "id inventado" }, { subject: "note", ids: ["a", "b"], reason: "ids do conjunto errado" }, { subject: "note", ids: ["n1"], reason: "um só" }] }, valid);
		expect(out).toEqual([{ type: "conflict", subject: "memory", ids: ["a", "b"], reason: "Um diz Curitiba, o outro Recife." }]);
	});
	it("lixo vira lista vazia", () => {
		expect(parseConflictFindings(undefined, valid)).toEqual([]);
		expect(parseConflictFindings({ conflicts: "x" }, valid)).toEqual([]);
	});
});

describe("doctorSummary", () => {
	it("diz que nada foi apagado e conta por tipo", () => {
		expect(doctorSummary([])).toContain("em ordem");
		const text = doctorSummary([{ type: "duplicate", subject: "memory", ids: ["a", "b"], reason: "" }, { type: "stale", subject: "note", ids: ["n"], reason: "" }, { type: "stale", subject: "note", ids: ["m"], reason: "" }]);
		expect(text).toBe("Achei 1 repetido, 2 velhos. Nada foi apagado: você decide o que fazer.");
	});
});

describe("doctorProposalId", () => {
	const cuid = (n: number) => `c${String(n).padStart(24, "0")}`;
	const finding = { type: "conflict" as const, subject: "memory" as const, ids: [1, 2, 3, 4, 5, 6].map(cuid) };

	it("cabe no limite de 64 caracteres das rotas mesmo com 6 ids de 25 caracteres", () => {
		const id = doctorProposalId("2026-11-08", finding);
		expect(id.length).toBeLessThanOrEqual(64);
		expect(id).toMatch(/^doctor:2026-11-08:[0-9a-f]{16}$/);
	});

	it("é estável para o mesmo achado e diferente para achados diferentes", () => {
		expect(doctorProposalId("2026-11-08", finding)).toBe(doctorProposalId("2026-11-08", { ...finding }));
		const other = [
			{ ...finding, ids: finding.ids.slice(0, 5) },
			{ ...finding, type: "duplicate" as const },
			{ ...finding, subject: "note" as const },
			{ ...finding, ids: [...finding.ids].reverse() },
		];
		const all = new Set([doctorProposalId("2026-11-08", finding), ...other.map((f) => doctorProposalId("2026-11-08", f))]);
		expect(all.size).toBe(5);
	});
});
