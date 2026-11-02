import { describe, expect, it, vi } from "vitest";
import { ComputerApiError, computerErrorText, getComputerSession, getViewerSocket, startComputer } from "./computer-api";

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

describe("endereço do WebSocket da tela ao vivo", () => {
	const ws = (id: string, vt = "VT.TOKEN", token = "WS.TOKEN") => {
		const params = new URLSearchParams({ autoconnect: "1", path: `v1/sandbox/sessions/${encodeURIComponent(id)}/viewer/websockify?t=${token}` });
		return `/v1/sandbox/vt/${vt}/vnc.html?${params.toString()}`;
	};
	it("devolve o wss:// do servidor salvo, sem o token da rota HTTP", async () => {
		const apiFetch = vi.fn(async () => ok({ url: ws("s 1", "SEGREDO-VT") }));
		const socket = await getViewerSocket(apiFetch, BASE, "s 1");
		expect(socket).toBe("wss://atlas.example.com/v1/sandbox/sessions/s%201/viewer/websockify?t=WS.TOKEN");
		expect(socket).not.toContain("SEGREDO-VT");
		expect(apiFetch).toHaveBeenCalledWith("/v1/sandbox/sessions/s%201/viewer-link", expect.anything());
	});
	it("recusa outra origem, sessão diferente, caminho fora do viewer e corpo sem url", async () => {
		for (const url of ["https://evil.example/v1/sandbox/vt/T/vnc.html", "//evil.example/v1/sandbox/vt/T/", "/v1/outra/rota", "vnc.html", "", ws("outra")]) {
			expect(await kindOf(getViewerSocket(async () => ok({ url }), BASE, "s"))).toBe("bad-link");
		}
		expect(await kindOf(getViewerSocket(async () => ok({}), BASE, "s"))).toBe("bad-link");
	});
	it("409 vira 'tela ao vivo indisponível'; 404 não diz se existe", async () => {
		const unavailable = await getViewerSocket(async () => status(409), BASE, "s").catch((e) => e as Error);
		expect(computerErrorText(unavailable)).toBe("A tela ao vivo não está disponível neste servidor.");
		const missing = await getViewerSocket(async () => status(404), BASE, "s").catch((e) => e as Error);
		expect(computerErrorText(missing)).toBe("Não encontrei o computador deste bot.");
	});
	it("o endereço e o token nunca entram na mensagem de erro", async () => {
		const error = (await getViewerSocket(async () => ok({ url: "https://evil.example/v1/sandbox/vt/SEGREDO/vnc.html" }), BASE, "s").catch((e: unknown) => e)) as Error;
		expect(`${error.message} ${computerErrorText(error)}`).not.toContain("SEGREDO");
	});
});
