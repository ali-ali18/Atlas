import { describe, expect, it } from "vitest";
import { staleNotice } from "./home-copy";

describe("staleNotice", () => {
	it("rede", () => expect(staleNotice("network")).toBe("Sem conexão. Mostrando a última lista salva."));
	it("servidor", () => expect(staleNotice("server")).toBe("Não consegui atualizar agora. Mostrando a última lista salva."));
});
