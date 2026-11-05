import { describe, expect, it, vi } from "vitest";
import { EventHub, type HubEvent } from "./event-hub";
import type { AppStateLike } from "./event-hub-client";
import { attachHomeLive } from "./home-live";

function setup(initialState = "active") {
	let state = initialState;
	const stateListeners = new Set<(s: string) => void>();
	const appState: AppStateLike = {
		current: () => state,
		subscribe: (listener) => {
			stateListeners.add(listener);
			return () => void stateListeners.delete(listener);
		},
	};
	const timers: { id: number; fn: () => void; ms: number }[] = [];
	let nextId = 1;
	const botListeners = new Set<(e: HubEvent) => void>();
	const resyncListeners = new Set<(r: "ready" | "resync") => void>();
	const hub = {
		subscribeBots: (l: (e: HubEvent) => void) => {
			botListeners.add(l);
			return () => void botListeners.delete(l);
		},
		onResync: (l: (r: "ready" | "resync") => void) => {
			resyncListeners.add(l);
			return () => void resyncListeners.delete(l);
		},
	} as unknown as Pick<EventHub, "subscribeBots" | "onResync">;
	const refresh = vi.fn();
	const stop = attachHomeLive({
		hub,
		appState,
		refresh,
		setTimeout: (fn, ms) => {
			const id = nextId++;
			timers.push({ id, fn, ms });
			return id;
		},
		clearTimeout: (handle) => {
			const index = timers.findIndex((t) => t.id === handle);
			if (index >= 0) timers.splice(index, 1);
		},
	});
	const fire = () => {
		const due = timers.splice(0);
		for (const t of due) t.fn();
	};
	const event = (type: string) => {
		for (const l of [...botListeners]) l({ seq: 1, type, payload: {} });
	};
	return {
		stop,
		refresh,
		timers,
		fire,
		event,
		resync: (r: "ready" | "resync") => resyncListeners.forEach((l) => l(r)),
		setApp: (next: string) => {
			state = next;
			stateListeners.forEach((l) => l(next));
		},
		botListeners,
		resyncListeners,
	};
}

describe("attachHomeLive", () => {
	it("uma rajada de eventos vira um refresh só, depois de ~300 ms", () => {
		const s = setup();
		s.event("message");
		s.event("run");
		s.event("read");
		expect(s.refresh).not.toHaveBeenCalled();
		expect(s.timers).toHaveLength(1);
		expect(s.timers[0]!.ms).toBe(300);
		s.fire();
		expect(s.refresh).toHaveBeenCalledTimes(1);
		s.event("bot");
		s.fire();
		expect(s.refresh).toHaveBeenCalledTimes(2);
	});

	it("ready e resync refazem o retrato", () => {
		const s = setup();
		s.resync("ready");
		s.fire();
		s.resync("resync");
		s.fire();
		expect(s.refresh).toHaveBeenCalledTimes(2);
	});

	it("voltar ao primeiro plano atualiza; ir para segundo plano não", () => {
		const s = setup();
		s.setApp("background");
		s.fire();
		expect(s.refresh).not.toHaveBeenCalled();
		s.setApp("active");
		s.fire();
		expect(s.refresh).toHaveBeenCalledTimes(1);
	});

	it("parar cancela o que estava marcado e solta as assinaturas", () => {
		const s = setup();
		s.event("message");
		s.stop();
		expect(s.timers).toHaveLength(0);
		expect(s.botListeners.size).toBe(0);
		expect(s.resyncListeners.size).toBe(0);
		s.fire();
		expect(s.refresh).not.toHaveBeenCalled();
	});

	it("sem hub, só a volta ao primeiro plano atualiza", () => {
		let state = "background";
		const listeners = new Set<(s: string) => void>();
		const refresh = vi.fn();
		const timers: (() => void)[] = [];
		attachHomeLive({
			hub: null,
			appState: { current: () => state, subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)) },
			refresh,
			setTimeout: (fn) => timers.push(fn),
		});
		state = "active";
		listeners.forEach((l) => l("active"));
		timers.forEach((fn) => fn());
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
