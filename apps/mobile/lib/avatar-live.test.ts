import { describe, expect, it } from "vitest";
import { createAvatarLive, type AvatarLiveInput } from "./avatar-live";

const base: AvatarLiveInput = { activity: { phase: "idle" }, running: false, paused: false, failures: 0, finishes: 0 };
const running = (activity: AvatarLiveInput["activity"], extra: Partial<AvatarLiveInput> = {}): AvatarLiveInput => ({ ...base, running: true, activity, ...extra });

describe("createAvatarLive", () => {
	it("sem run fica em repouso e sem texto", () => {
		const live = createAvatarLive();
		expect(live.sync(base, 0)).toMatchObject({ state: "idle", label: null });
	});

	it("pensando, depois uma ferramenta de pesquisa com o passo no texto", () => {
		const live = createAvatarLive();
		expect(live.sync(running({ phase: "thinking" }), 0)).toMatchObject({ state: "thinking", label: "Pensando…" });
		const out = live.sync(running({ phase: "tool", tool: "api_search", step: 1, maxSteps: 4 }), 100);
		expect(out).toMatchObject({ state: "searching", label: "Pesquisando na web (passo 2 de 4)" });
	});

	it("troca de ferramenta antes de 1,2 s espera a permanência mínima", () => {
		const live = createAvatarLive();
		live.sync(running({ phase: "tool", tool: "api_search", step: 0, maxSteps: 4 }), 0);
		const early = live.sync(running({ phase: "tool", tool: "write_file", step: 1, maxSteps: 4 }), 500);
		expect(early.state).toBe("searching");
		expect(early.nextMs).toBe(700);
		const later = live.sync(running({ phase: "tool", tool: "write_file", step: 1, maxSteps: 4 }), 1300);
		expect(later).toMatchObject({ state: "working", label: "Escrevendo código (passo 2 de 4)" });
	});

	it("depois da ferramenta a família segue na tela por um tempo, com o texto dela", () => {
		const live = createAvatarLive();
		live.sync(running({ phase: "tool", tool: "browser_snapshot", step: 0, maxSteps: 3 }), 0);
		const out = live.sync(running({ phase: "thinking" }), 2000);
		expect(out).toMatchObject({ state: "reading", label: "Lendo a página (passo 1 de 3)" });
		expect(live.sync(running({ phase: "thinking" }), 5000).state).toBe("thinking");
	});

	it("ferramenta que falhou mostra a cara de erro por ~1,8 s e volta", () => {
		const live = createAvatarLive();
		live.sync(running({ phase: "thinking" }), 0);
		const failed = live.sync(running({ phase: "thinking" }, { failures: 1 }), 3000);
		expect(failed).toMatchObject({ state: "failed", label: "Algo deu errado" });
		expect(live.sync(running({ phase: "thinking" }, { failures: 1 }), 3000 + 1800).state).toBe("thinking");
	});

	it("o fim do run comemora uma vez (~2,6 s) e volta ao repouso", () => {
		const live = createAvatarLive();
		live.sync(running({ phase: "writing" }), 0);
		const done = live.sync({ ...base, finishes: 1 }, 5000);
		expect(done).toMatchObject({ state: "happy", label: "Pronto" });
		expect(done.nextMs).toBe(2600);
		expect(live.sync({ ...base, finishes: 1 }, 5000 + 2600).state).toBe("idle");
		expect(live.sync({ ...base, finishes: 1 }, 20000).state).toBe("idle");
	});

	it("contador antigo na primeira leitura não dispara reação", () => {
		const live = createAvatarLive();
		expect(live.sync({ ...base, failures: 3, finishes: 2 }, 0).state).toBe("idle");
	});

	it("parado esperando a pessoa vira waiting na hora", () => {
		const live = createAvatarLive();
		live.sync(running({ phase: "tool", tool: "api_search", step: 0, maxSteps: 3 }), 0);
		expect(live.sync(running({ phase: "idle" }, { paused: true }), 100)).toMatchObject({ state: "waiting", label: "Esperando você" });
	});

	it("escrevendo a resposta vira writing", () => {
		const live = createAvatarLive();
		expect(live.sync(running({ phase: "writing" }), 0)).toMatchObject({ state: "writing", label: "Escrevendo…" });
	});
});
