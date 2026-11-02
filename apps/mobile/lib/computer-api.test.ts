import { describe, expect, it, vi } from "vitest";
import { ComputerApiError, computerErrorText, getComputerSession, getViewerLink, sendKey, sendText, startComputer } from "./computer-api";
import { VM_TEXT_MAX } from "./computer-text";

const BASE = "https://atlas.example.com";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response(JSON.stringify({ error: "detalhe técnico" }), { status: code });

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ComputerApiError ? error.kind : "outro";
	}
	return undefined;
}

describe("sessão do computador", () => {
	it("busca pela conversa com wake=0 (não religa a VM)", async () => {
		const apiFetch = vi.fn(async () => ok({ session: { sessionId: "s1", status: "running", viewerUrl: "x", createdAt: "y" } }));
		expect(await getComputerSession(apiFetch, "c 1")).toEqual({ sessionId: "s1", status: "running" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/sandbox/sessions?conversationId=c%201&wake=0", expect.anything());
	});
	it("sem sessão ou formato estranho vira null", async () => {
		expect(await getComputerSession(async () => ok({ session: null }), "c")).toBeNull();
		expect(await getComputerSession(async () => ok({}), "c")).toBeNull();
		expect(await getComputerSession(async () => ok({ session: { sessionId: "s", status: "outra" } }), "c")).toBeNull();
	});
	it("liga o computador com POST e a conversa", async () => {
		const apiFetch = vi.fn(async () => ok({ sessionId: "s2", status: "starting", viewerUrl: "", createdAt: "" }));
		expect(await startComputer(apiFetch, "c1")).toEqual({ sessionId: "s2", status: "starting" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/sandbox/sessions", expect.objectContaining({ method: "POST", body: JSON.stringify({ conversationId: "c1" }) }));
		expect(await kindOf(startComputer(async () => ok({}), "c1"))).toBe("unavailable");
	});
	it("401, 404, 5xx e rede viram erros classificados, sem o texto do servidor", async () => {
		expect(await kindOf(getComputerSession(async () => status(401), "c"))).toBe("unauthorized");
		expect(await kindOf(getComputerSession(async () => status(404), "c"))).toBe("not-found");
		expect(await kindOf(getComputerSession(async () => status(503), "c"))).toBe("unavailable");
		expect(await kindOf(getComputerSession(async () => Promise.reject(new TypeError("Network request failed")), "c"))).toBe("network");
		const error = await getComputerSession(async () => status(404), "c").catch((e) => e as Error);
		expect(computerErrorText(error)).not.toContain("detalhe técnico");
	});
});

describe("link da tela ao vivo", () => {
	const vt = "/v1/sandbox/vt/TOKEN/vnc.html?autoconnect=1&path=v1%2Fx";
	it("devolve a URL absoluta do servidor salvo", async () => {
		const apiFetch = vi.fn(async () => ok({ url: vt }));
		expect(await getViewerLink(apiFetch, BASE, "s 1")).toBe(`${BASE}${vt}`);
		expect(apiFetch).toHaveBeenCalledWith("/v1/sandbox/sessions/s%201/viewer-link", expect.anything());
	});
	it("recusa outra origem, caminho fora do viewer e corpo sem url", async () => {
		for (const url of ["https://evil.example/v1/sandbox/vt/T/vnc.html", "//evil.example/v1/sandbox/vt/T/", "/v1/outra/rota", "vnc.html", ""]) {
			expect(await kindOf(getViewerLink(async () => ok({ url }), BASE, "s"))).toBe("bad-link");
		}
		expect(await kindOf(getViewerLink(async () => ok({}), BASE, "s"))).toBe("bad-link");
	});
	it("409 vira 'tela ao vivo indisponível'; 404 não diz se existe", async () => {
		const unavailable = await getViewerLink(async () => status(409), BASE, "s").catch((e) => e as Error);
		expect(computerErrorText(unavailable)).toBe("A tela ao vivo não está disponível neste servidor.");
		const missing = await getViewerLink(async () => status(404), BASE, "s").catch((e) => e as Error);
		expect(computerErrorText(missing)).toBe("Não encontrei o computador deste bot.");
	});
	it("o link e o token nunca entram na mensagem de erro", async () => {
		const error = (await getViewerLink(async () => ok({ url: "https://evil.example/v1/sandbox/vt/SEGREDO/vnc.html" }), BASE, "s").catch((e: unknown) => e)) as Error;
		expect(`${error.message} ${computerErrorText(error)}`).not.toContain("SEGREDO");
	});
});

describe("texto e teclas", () => {
	it("manda o texto como foi dado, para a sessão codificada", async () => {
		const apiFetch = vi.fn(async () => ok({ ok: true }));
		await sendText(apiFetch, "s 1", "  olá\nmundo ");
		expect(apiFetch).toHaveBeenCalledWith("/v1/sandbox/sessions/s%201/type", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "  olá\nmundo " }) }));
	});
	it("vazio e acima do limite nem chegam ao servidor", async () => {
		const apiFetch = vi.fn(async () => ok({ ok: true }));
		expect(await kindOf(sendText(apiFetch, "s", "  \n"))).toBe("bad-input");
		expect(await kindOf(sendText(apiFetch, "s", "a".repeat(VM_TEXT_MAX + 1)))).toBe("bad-input");
		await sendText(apiFetch, "s", "a".repeat(VM_TEXT_MAX));
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
	it("falha ao enviar vira a frase amigável", async () => {
		const error = await sendText(async () => status(500), "s", "oi").catch((e) => e as Error);
		expect(computerErrorText(error)).toBe("Não foi possível enviar para a VM.");
		const key = await sendKey(async () => status(500), "s", "Return").catch((e) => e as Error);
		expect(computerErrorText(key)).toBe("Não foi possível enviar para a VM.");
		expect(await kindOf(sendText(async () => status(401), "s", "oi"))).toBe("unauthorized");
	});
	it("Enter é Return e Backspace é BackSpace", async () => {
		const apiFetch = vi.fn(async () => ok({ ok: true }));
		await sendKey(apiFetch, "s", "Return");
		await sendKey(apiFetch, "s", "BackSpace");
		expect(apiFetch).toHaveBeenNthCalledWith(1, "/v1/sandbox/sessions/s/key", expect.objectContaining({ body: JSON.stringify({ combo: "Return" }) }));
		expect(apiFetch).toHaveBeenNthCalledWith(2, "/v1/sandbox/sessions/s/key", expect.objectContaining({ body: JSON.stringify({ combo: "BackSpace" }) }));
	});
});
