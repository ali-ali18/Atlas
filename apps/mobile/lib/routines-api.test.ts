import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { listRoutineRuns, listRoutines, routinesErrorText, setRoutineEnabled } from "./routines-api";
import { RoutinesStore } from "./routines-store";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const routine = (id: string, enabled = true) => ({ id, name: id, enabled, groupId: null });

describe("api de rotinas", () => {
	it("lista rotinas e grupos do bot pelo id codificado", async () => {
		const apiFetch = vi.fn(async (path: string) => (path.endsWith("/routines") ? ok({ routines: [routine("a")] }) : ok({ groups: [] })));
		const result = await listRoutines(apiFetch, "bot 1");
		expect(result.routines).toHaveLength(1);
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/bot%201/routines", expect.anything());
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/bot%201/routine-groups", expect.anything());
	});
	it("corpo sem lista vira lista vazia; erro vira ChatApiError", async () => {
		expect((await listRoutines(async () => ok({}), "b")).routines).toEqual([]);
		await expect(listRoutines(async () => new Response("", { status: 404 }), "b")).rejects.toBeInstanceOf(ChatApiError);
	});
	it("pausar manda só { enabled }", async () => {
		const apiFetch = vi.fn(async () => ok({}));
		await setRoutineEnabled(apiFetch, "b", "r 1", false);
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/b/routines/r%201", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }));
	});
	it("histórico", async () => {
		expect(await listRoutineRuns(async () => ok({ runs: [{ id: "x" }] }), "b", "r")).toHaveLength(1);
	});
	it("frases de erro sem texto técnico", () => {
		expect(routinesErrorText(new ChatApiError("x", 401), "load")).toBe("Sua sessão expirou. Entre de novo.");
		expect(routinesErrorText(new ChatApiError("x", 404), "pause")).toContain("Não encontrei");
		expect(routinesErrorText(new ChatApiError("x", 500), "pause")).toBe("Não foi possível pausar esta rotina.");
		expect(routinesErrorText(new ChatApiError("x", 500), "resume")).toBe("Não foi possível retomar esta rotina.");
		expect(routinesErrorText(new TypeError("Network request failed"), "load")).toBe("Sem conexão com o seu servidor. Tente de novo.");
	});
});

describe("estado das rotinas", () => {
	const loaded = async (patchOk: boolean) => {
		const store = new RoutinesStore();
		const calls: string[] = [];
		const apiFetch = async (path: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (init?.method === "PATCH") return new Response("", { status: patchOk ? 200 : 500 });
			return path.endsWith("/routines") ? ok({ routines: [routine("a", true), routine("b", false)] }) : ok({ groups: [] });
		};
		await store.load(apiFetch, "bot");
		return { store, apiFetch, calls };
	};
	it("pausar muda na hora e fica quando o servidor aceita", async () => {
		const { store, apiFetch } = await loaded(true);
		const pending = store.toggle(apiFetch, "bot", "a", false);
		expect(store.get("bot").routines[0]?.enabled).toBe(false);
		expect(store.get("bot").busy.has("a")).toBe(true);
		await pending;
		expect(store.get("bot").routines[0]?.enabled).toBe(false);
		expect(store.get("bot").busy.size).toBe(0);
		expect(store.get("bot").error).toBeNull();
	});
	it("o servidor recusa: volta atrás e avisa em palavras simples", async () => {
		const { store, apiFetch } = await loaded(false);
		await store.toggle(apiFetch, "bot", "b", true);
		expect(store.get("bot").routines[1]?.enabled).toBe(false);
		expect(store.get("bot").error).toBe("Não foi possível retomar esta rotina.");
		expect(store.get("bot").busy.size).toBe(0);
	});
	it("toque duplo enquanto o pedido está em voo não manda dois", async () => {
		const { store, apiFetch, calls } = await loaded(true);
		const first = store.toggle(apiFetch, "bot", "a", false);
		await store.toggle(apiFetch, "bot", "a", true);
		await first;
		expect(calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(1);
	});
	it("falha ao carregar guarda a frase de erro", async () => {
		const store = new RoutinesStore();
		await store.load(async () => new Response("", { status: 500 }), "bot");
		expect(store.get("bot").error).toBe("Não consegui carregar as rotinas agora.");
		expect(store.get("bot").loading).toBe(false);
	});
	it("reset apaga tudo (troca de conta)", async () => {
		const { store } = await loaded(true);
		store.reset();
		expect(store.get("bot").routines).toEqual([]);
	});
});

describe("estado: corridas", () => {
	const gate = () => {
		let open!: () => void;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { wait, open };
	};
	it("a resposta do load antigo não sobrescreve o load novo", async () => {
		const store = new RoutinesStore();
		const slow = gate();
		let calls = 0;
		const apiFetch = async (path: string) => {
			const mine = ++calls;
			if (path.endsWith("/routines") && mine === 1) await slow.wait;
			return path.endsWith("/routines") ? ok({ routines: [routine(mine === 1 ? "velha" : "nova")] }) : ok({ groups: [] });
		};
		const first = store.load(apiFetch, "bot");
		const second = store.load(apiFetch, "bot");
		await second;
		slow.open();
		await first;
		expect(store.get("bot").routines.map((item) => item.id)).toEqual(["nova"]);
		expect(store.get("bot").loading).toBe(false);
	});
	it("load que chega no meio de um pausar não desfaz o que a pessoa tocou", async () => {
		const store = new RoutinesStore();
		const patch = gate();
		const apiFetch = async (path: string, init?: RequestInit) => {
			if (init?.method === "PATCH") {
				await patch.wait;
				return new Response("", { status: 200 });
			}
			return path.endsWith("/routines") ? ok({ routines: [routine("a", true)] }) : ok({ groups: [] });
		};
		await store.load(apiFetch, "bot");
		const toggling = store.toggle(apiFetch, "bot", "a", false);
		await store.load(apiFetch, "bot");
		expect(store.get("bot").routines[0]?.enabled).toBe(false);
		patch.open();
		await toggling;
		expect(store.get("bot").routines[0]?.enabled).toBe(false);
	});
	it("resposta de antes da troca de conta é ignorada", async () => {
		const store = new RoutinesStore();
		const slow = gate();
		const apiFetch = async (path: string) => {
			await slow.wait;
			return path.endsWith("/routines") ? ok({ routines: [routine("do-outro-dono")] }) : ok({ groups: [] });
		};
		const pending = store.load(apiFetch, "bot");
		store.reset();
		slow.open();
		await pending;
		expect(store.get("bot").routines).toEqual([]);
	});
});
