import { describe, expect, it } from "vitest";
import { createSweepSignals, SWEEP_SIGNAL_CHANNEL } from "./sweep-signals.js";

describe("sweep-signals: API acorda as varreduras do worker", () => {
	it("publica no canal atlas:sweeps e entrega só os tipos conhecidos", async () => {
		const subscribed = new Set<string>();
		const listeners: Array<(channel: string, message: string) => void> = [];
		const signals = createSweepSignals({
			createPublisher: () => ({
				publish: async (channel: string, message: string) => {
					if (subscribed.has(channel)) for (const listener of listeners) listener(channel, message);
					return 1;
				},
			}),
			createSubscriber: () => ({
				subscribe: async (channel: string) => void subscribed.add(channel),
				unsubscribe: async (channel: string) => void subscribed.delete(channel),
				on: (event, listener) => void (event === "message" && listeners.push(listener)),
			}),
		});
		const got: string[] = [];
		const off = signals.subscribe((kind) => got.push(kind));
		expect([...subscribed]).toEqual([SWEEP_SIGNAL_CHANNEL]);
		await signals.publish("groups");
		await signals.publish("bot-messages");
		await signals.publish("cancel" as never);
		expect(got).toEqual(["groups", "bot-messages"]);
		off();
		await signals.publish("groups");
		expect(got).toHaveLength(2);
		await signals.close();
	});
});
