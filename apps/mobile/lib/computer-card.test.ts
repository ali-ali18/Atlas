import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeRun } from "./chat-api";
import type { ChatItem } from "./chat-types";
import { ComputerApiError, getComputerFrame } from "./computer-api";
import { conversationFrameFetcher, createFramePoller } from "./computer-thumb";
import type { ApiFetch } from "./home-sync";
import { computerNote, computerResumeOptions, computerSubtitle, deadlineLine, loginCardKind, loginOutcome, loginToItem, parseDeadline } from "./request-cards";

type Login = Extract<ChatItem, { kind: "login" }>;
const base: Login = { id: "l", kind: "login", loginId: "lg1", site: "github.com", url: "https://github.com/login", runId: "r9", status: "pending" };
const v3: Login = { ...base, ownerWait: true };

describe("escolha do cartão de login de página (loginCardKind)", () => {
	it("sem o sinal do v3 (ownerWait) o cartão é o Formulário de hoje, mesmo com captcha", () => {
		expect(loginCardKind(base)).toBe("form");
		expect(loginCardKind({ ...base, reason: "captcha" })).toBe("form");
	});
	it("com ownerWait, login e captcha viram o cartão do Computador", () => {
		expect(loginCardKind(v3)).toBe("computer");
		expect(loginCardKind({ ...v3, reason: "captcha" })).toBe("computer");
	});
	it("campo de código e Cofre continuam no Formulário (têm gaveta), mesmo no v3", () => {
		expect(loginCardKind({ ...v3, codeField: true })).toBe("form");
		expect(loginCardKind({ ...v3, vault: { name: "gh", label: "GitHub", username: "eu" } as never })).toBe("form");
		expect(loginCardKind({ ...v3, vaultTried: "pediu mais um passo" })).toBe("form");
	});
	it("conector nunca é o cartão do Computador", () => {
		expect(loginCardKind({ ...v3, composioToolkit: "gmail" })).toBe("form");
	});
	it("cartão resolvido com desfecho gravado também é v3", () => {
		expect(loginCardKind({ ...base, status: "done", outcome: "takeover" })).toBe("computer");
	});
});

describe("mapeamento dos botões para o corpo do resume", () => {
	it("Terminei = sem via; Pular = skip; Assumir = takeover", () => {
		expect(computerResumeOptions("done")).toEqual({});
		expect(computerResumeOptions("skip")).toEqual({ via: "skip" });
		expect(computerResumeOptions("takeover")).toEqual({ via: "takeover" });
	});
	it("o POST /v1/runs/:id/resume leva exatamente esse corpo", async () => {
		const bodies: unknown[] = [];
		const apiFetch: ApiFetch = async (_path, init) => {
			bodies.push(init?.body ?? null);
			return new Response(JSON.stringify({ enqueued: true }), { status: 200 });
		};
		await resumeRun(apiFetch, "r1", computerResumeOptions("done"));
		await resumeRun(apiFetch, "r1", computerResumeOptions("skip"));
		await resumeRun(apiFetch, "r1", computerResumeOptions("takeover"));
		expect(bodies).toEqual([null, JSON.stringify({ via: "skip" }), JSON.stringify({ via: "takeover" })]);
	});
});

describe("selo por desfecho (outcome)", () => {
	const done = { ...v3, status: "done" as const };
	it("pendente não tem selo", () => expect(loginOutcome(v3)).toBeNull());
	it("cada valor do contrato tem o seu texto", () => {
		expect(loginOutcome({ ...done, outcome: "done" })).toEqual({ tone: "success", label: "Concluído" });
		expect(loginOutcome({ ...done, outcome: "takeover" })).toEqual({ tone: "success", label: "Você assumiu" });
		expect(loginOutcome({ ...done, outcome: "skipped" })).toEqual({ tone: "muted", label: "Pulado" });
		expect(loginOutcome({ ...done, outcome: "skipped_timeout" })).toEqual({ tone: "muted", label: "Tempo esgotado · segui sem isso" });
		expect(loginOutcome({ ...done, outcome: "ignored" })).toEqual({ tone: "muted", label: "Dispensado" });
	});
	it("sem desfecho (servidor antigo) mantém o selo de antes", () => {
		expect(loginOutcome({ ...base, status: "done" })).toEqual({ tone: "success", label: "Concluído" });
		expect(loginOutcome({ ...base, status: "done", reason: "captcha" })).toEqual({ tone: "success", label: "Verificado" });
	});
});

describe("campos do contrato no item", () => {
	it("lê ownerWait, deadlineAt e outcome (só resolvido) do cartão", () => {
		const item = loginToItem("i", { loginId: "a", site: "s", url: "https://s.com", status: "done", ownerWait: true, deadlineAt: "2026-11-04T21:30:00Z", outcome: "skipped" });
		expect(item).toMatchObject({ ownerWait: true, deadlineAt: "2026-11-04T21:30:00.000Z", outcome: "skipped" });
		expect(loginToItem("i", { loginId: "a", site: "s", url: "https://s.com", ownerWait: true, outcome: "done" }).outcome).toBeUndefined();
	});
	it("ignora lixo", () => {
		const item = loginToItem("i", { loginId: "a", site: "s", url: "https://s.com", status: "done", ownerWait: "sim", deadlineAt: "ontem", outcome: "outro" });
		expect(item.ownerWait).toBeUndefined();
		expect(item.deadlineAt).toBeUndefined();
		expect(item.outcome).toBeUndefined();
		expect(parseDeadline(42)).toBeUndefined();
	});
});

describe("textos do cartão", () => {
	it("prazo, com now injetado", () => {
		const at = new Date(2026, 10, 4, 18, 5, 0);
		const now = new Date(2026, 10, 4, 17, 0, 0).getTime();
		expect(deadlineLine(at.toISOString(), now)).toBe("Sigo sem isso às 18:05");
		expect(deadlineLine(at.toISOString(), at.getTime())).toBe("Tempo esgotado · segui sem isso");
		expect(deadlineLine(at.toISOString(), at.getTime() + 60_000)).toBe("Tempo esgotado · segui sem isso");
		expect(deadlineLine(undefined, now)).toBeNull();
		expect(deadlineLine("lixo", now)).toBeNull();
	});
	it("subtítulo e nota em pt-BR", () => {
		expect(computerSubtitle(base)).toBe("Entre na sua conta do github.com e depois devolva a tela.");
		expect(computerSubtitle({ ...base, reason: "captcha" })).toContain("verificação");
		expect(computerNote("Atlas")).toBe("Se você entrar, faz isso no navegador do computador do Atlas, e a sessão fica salva lá. O site pode te mandar um aviso de novo acesso.");
	});
});

describe("captura da tela (screenshot)", () => {
	const png = (bytes = 8) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });
	const toUri = async (blob: Blob) => `data:image/png;base64,${blob.size}`;
	it("pede a captura da sessão e devolve um data URI", async () => {
		const apiFetch = vi.fn<ApiFetch>(async () => png());
		expect(await getComputerFrame(apiFetch, "s 1", toUri)).toBe("data:image/png;base64,8");
		expect(apiFetch.mock.calls[0]![0]).toBe("/v1/sandbox/sessions/s%201/screenshot");
	});
	it("recusa o que não é imagem, vazio ou enorme, e classifica o erro HTTP", async () => {
		const kind = async (response: Response) => getComputerFrame(async () => response, "s", toUri).catch((e: unknown) => (e as ComputerApiError).kind);
		expect(await kind(new Response("oi", { status: 200, headers: { "content-type": "text/html" } }))).toBe("unavailable");
		expect(await kind(png(0))).toBe("unavailable");
		expect(await kind(new Response(null, { status: 404 }))).toBe("not-found");
		expect(await kind(new Response(null, { status: 401 }))).toBe("unauthorized");
	});
});

describe("laço da miniatura", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	const flush = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	it("captura a cada intervalo enquanto roda e PARA ao resolver (stop)", async () => {
		const frames: string[] = [];
		let n = 0;
		const fetchFrame = vi.fn(async () => `f${++n}`);
		const poller = createFramePoller({ fetchFrame, onFrame: (uri) => frames.push(uri), intervalMs: 1000 });
		poller.start();
		await flush();
		expect(frames).toEqual(["f1"]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(frames).toEqual(["f1", "f2"]);
		poller.stop();
		expect(poller.running).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchFrame).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("a resposta que chega depois do stop é descartada", async () => {
		let release: (uri: string) => void = () => undefined;
		const frames: string[] = [];
		const poller = createFramePoller({ fetchFrame: () => new Promise<string>((resolve) => (release = resolve)), onFrame: (uri) => frames.push(uri), intervalMs: 1000 });
		poller.start();
		poller.stop();
		release("tarde");
		await flush();
		expect(frames).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("erro passageiro mantém o laço; sessão sumida (404/401) para e avisa", async () => {
		const gone = vi.fn();
		let calls = 0;
		const poller = createFramePoller({
			fetchFrame: async () => {
				calls += 1;
				throw new ComputerApiError(calls === 1 ? "network" : "not-found");
			},
			onFrame: () => undefined,
			onGone: gone,
			intervalMs: 1000,
		});
		poller.start();
		await flush();
		expect(poller.running).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(gone).toHaveBeenCalledTimes(1);
		expect(poller.running).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls).toBe(2);
	});
	it("start duas vezes não duplica o laço; pode recomeçar depois do stop", async () => {
		const fetchFrame = vi.fn(async () => "x");
		const poller = createFramePoller({ fetchFrame, onFrame: () => undefined, intervalMs: 1000 });
		poller.start();
		poller.start();
		await flush();
		expect(fetchFrame).toHaveBeenCalledTimes(1);
		poller.stop();
		poller.start();
		await flush();
		expect(fetchFrame).toHaveBeenCalledTimes(2);
		poller.stop();
	});
	it("a busca da conversa não religa a VM: sem sessão ligada não há captura", async () => {
		const calls: string[] = [];
		const apiFetch: ApiFetch = async (path) => {
			calls.push(path);
			return new Response(JSON.stringify({ session: null }), { status: 200 });
		};
		expect(await conversationFrameFetcher(apiFetch, "c1")()).toBeNull();
		expect(calls).toEqual(["/v1/sandbox/sessions?conversationId=c1&wake=0"]);
	});
});
