import { describe, expect, it } from "vitest";
import { ARTIFACT_READ_PAGE_CHARS } from "../tools/artifact-read.js";
import { createRereadGuard, isRereadNotice } from "./reread-guard.js";

const page = (id: string, from: number, to: number, total: number) =>
	`artifact:${id} characters ${from}-${to} of ${total}. Next: artifact_read with id "${id}" and offset ${to}.\n...`;

describe("guarda de releitura de artifact_read", () => {
	it("enquanto falta página, tudo é lido normalmente", () => {
		const guard = createRereadGuard();
		guard.record({ id: "a1" }, page("a1", 0, 8000, 20000), 3);
		guard.record({ id: "a1", offset: 8000 }, page("a1", 8000, 16000, 20000), 4);
		expect(guard.check({ id: "a1" })).toBeNull();
		expect(guard.check({ id: "a1", offset: 8000 })).toBeNull();
	});

	it("com o artefato todo lido, reler a mesma página vira aviso curto (com o passo da 1ª leitura)", () => {
		const guard = createRereadGuard();
		guard.record({ id: "a1" }, page("a1", 0, 8000, 20000), 3);
		guard.record({ id: "a1", offset: 8000 }, page("a1", 8000, 16000, 20000), 4);
		guard.record({ id: "a1", offset: 16000 }, page("a1", 16000, 20000, 20000), 5);
		const notice = guard.check({ id: "a1", offset: 8000 });
		expect(notice).toBe("Already read at step 5; use what you have.");
		expect(isRereadNotice(notice!)).toBe(true);
		expect(guard.check({ id: "a1" })).toBe("Already read at step 4; use what you have.");
	});

	it("busca nova (find) ou outro artefato não é bloqueada", () => {
		const guard = createRereadGuard();
		guard.record({ id: "a1" }, page("a1", 0, 4000, 4000), 0);
		expect(guard.check({ id: "a1", find: "preço" })).toBeNull();
		expect(guard.check({ id: "b2" })).toBeNull();
		guard.record({ id: "a1", find: "preço" }, 'artifact:a1 (4000 chars): 1 match(es) for "preço"', 1);
		expect(guard.check({ id: "a1", find: "PREÇO" })).toBe("Already read at step 2; use what you have.");
	});

	it("sem id, o aviso nunca se aplica", () => {
		expect(createRereadGuard().check({})).toBeNull();
	});

	it("artifact:X e X contam como mesma leitura (normaliza id)", () => {
		const guard = createRereadGuard();
		guard.record({ id: "a1" }, page("a1", 0, 100, 100), 1);
		expect(guard.check({ id: "artifact:a1" })).toBe("Already read at step 2; use what you have.");
		guard.record({ id: "artifact:b2" }, page("b2", 0, 100, 100), 4);
		expect(guard.check({ id: "b2" })).toBe("Already read at step 5; use what you have.");
	});

	it("tamanho omitido = tamanho padrão de artifact_read", () => {
		const guard = createRereadGuard();
		guard.record({ id: "b2", length: ARTIFACT_READ_PAGE_CHARS }, page("b2", 0, ARTIFACT_READ_PAGE_CHARS, ARTIFACT_READ_PAGE_CHARS), 2);
		expect(guard.check({ id: "b2" })).toBe("Already read at step 3; use what you have.");
		const other = createRereadGuard();
		other.record({ id: "b2" }, page("b2", 0, ARTIFACT_READ_PAGE_CHARS, ARTIFACT_READ_PAGE_CHARS), 2);
		expect(other.check({ id: "b2", length: ARTIFACT_READ_PAGE_CHARS })).toBe("Already read at step 3; use what you have.");
	});

	it("resultado de find com 'characters 0-9 of 9' no corpo (sem cabeçalho artifact:) não registra total", () => {
		const guard = createRereadGuard();
		const body = 'artifact:c3 (9 chars): 1 match(es) for "x"\n@0: see characters 0-9 of 9 in context';
		guard.record({ id: "c3", find: "x" }, body, 3);
		expect(guard.check({ id: "c3", find: "x" })).toBeNull();
		const mid = 'no header here\nartifact:c3 characters 0-9 of 9. Next: ...';
		guard.record({ id: "c3", find: "y" }, mid, 4);
		expect(guard.check({ id: "c3", find: "y" })).toBeNull();
	});
});
