import { describe, expect, it } from "vitest";
import { createFixtureEmail } from "./v4-ports.js";
import type { NativeFixture } from "./scenario.js";

const inbox = (messages: unknown[]): NativeFixture => ({ tool: "email_inbox", result: { ok: true, summary: JSON.stringify(messages) } }) as NativeFixture;

describe("e-mail no eval do v4", () => {
	it("sem o fixture email_inbox não há conta conectada (nada de caixa inventada)", async () => {
		const email = createFixtureEmail([], "eval-user");
		expect(await email.ports.accounts.list("eval-user")).toEqual([]);
	});
	it("o fixture vira a caixa do dono do run e de mais ninguém", async () => {
		const email = createFixtureEmail([inbox([{ id: "g1", from: "ana@empresa.test", subject: "Orçamento", body: "Oi" }])], "eval-user");
		expect((await email.ports.accounts.list("eval-user")).map((a) => a.source)).toEqual(["gmail"]);
		expect(await email.ports.accounts.list("outro-dono")).toEqual([]);
		const account = (await email.ports.accounts.open("eval-user", "gmail"))!;
		expect((await account.list("eval-user", { limit: 5 })).messages.map((m) => m.id)).toEqual(["g1"]);
		expect(await email.ports.accounts.open("outro-dono", "gmail")).toBeNull();
	});
});
