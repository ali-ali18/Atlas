import { describe, expect, it, vi } from "vitest";
import { BotMessageError } from "@workspace/db";
import {
	SEND_TO_BOT_TOOL,
	executeSendToBot,
	executeSetPrimaryBot,
	shouldExposeSendToBot,
	shouldExposeSetPrimaryBot,
	type SetPrimaryBotDeps,
} from "./bot-messaging.js";

describe("exposição das tools", () => {
	it("send_to_bot só com 2+ bots e conversa de chat/bot", () => {
		expect(shouldExposeSendToBot({ origin: "chat", botCount: 1 })).toBe(false);
		expect(shouldExposeSendToBot({ origin: "chat", botCount: 2 })).toBe(true);
		expect(shouldExposeSendToBot({ origin: "bot", botCount: 3 })).toBe(true);
		expect(shouldExposeSendToBot({ origin: "routine", botCount: 3 })).toBe(false);
		expect(shouldExposeSendToBot({ origin: "subagent", botCount: 3 })).toBe(false);
	});

	it("set_primary_bot só com humano, 2+ bots e nenhum principal", () => {
		expect(shouldExposeSetPrimaryBot({ origin: "chat", botCount: 2, hasPrimary: false })).toBe(true);
		expect(shouldExposeSetPrimaryBot({ origin: "chat", botCount: 2, hasPrimary: true })).toBe(false);
		expect(shouldExposeSetPrimaryBot({ origin: "chat", botCount: 1, hasPrimary: false })).toBe(false);
		expect(shouldExposeSetPrimaryBot({ origin: "bot", botCount: 2, hasPrimary: false })).toBe(false);
	});

	it("a descrição instrui a encerrar o turno e não menciona o produto", () => {
		const text = SEND_TO_BOT_TOOL.function.description ?? "";
		expect(text).toContain("END YOUR TURN");
		expect(text).toContain("pedi pro X");
		expect(text).not.toContain("Atlas");
	});
});

describe("executeSendToBot", () => {
	const ctx = { userId: "u1", botId: "a", runId: "run-1", origin: "chat" as string | undefined };

	it("devolve delivered + alvo e repassa remetente/run", async () => {
		const send = vi.fn(async () => ({ id: "m1", targetId: "b", targetName: "Bia" }));
		const out = await executeSendToBot({ bot: "bia", message: " oi ", title: "Oi" }, ctx, { send });
		expect(JSON.parse(out.summary)).toMatchObject({ delivered: true, target: "Bia" });
		expect(send).toHaveBeenCalledWith({ userId: "u1", fromBotId: "a", fromRunId: "run-1", bot: "bia", message: "oi", title: "Oi" });
	});

	it("erro de regra vira erro de tool com texto limpo", async () => {
		const send = vi.fn(async () => {
			throw new BotMessageError("Você não pode enviar mensagem para si mesmo.");
		});
		await expect(executeSendToBot({ bot: "a", message: "x", title: "t" }, ctx, { send })).rejects.toThrow("si mesmo");
	});

	it("valida args e origem antes de enviar", async () => {
		const send = vi.fn();
		await expect(executeSendToBot({ message: "x" }, ctx, { send })).rejects.toThrow("bot");
		await expect(executeSendToBot({ bot: "b" }, ctx, { send })).rejects.toThrow("message");
		await expect(executeSendToBot({ bot: "b", message: "x" }, { ...ctx, origin: "routine" }, { send })).rejects.toThrow("rotinas");
		await expect(executeSendToBot({ bot: "b", message: "x" }, { ...ctx, userId: undefined }, { send })).rejects.toThrow("usuário");
		expect(send).not.toHaveBeenCalled();
	});
});

describe("executeSetPrimaryBot", () => {
	const roster = [
		{ id: "a", name: "Ana", isPrimary: false },
		{ id: "b", name: "Bia", isPrimary: false },
	];
	const ctx = { userId: "u1", botId: "a", conversationId: "c1", runId: "run-1", origin: "chat" as string | undefined };
	const mk = (rows = roster) => {
		const savePending = vi.fn(async () => undefined);
		const deps: SetPrimaryBotDeps = { roster: async () => rows, savePending };
		return { deps, savePending };
	};

	it("propõe o próprio bot por padrão e só grava a intenção pendente + card", async () => {
		const { deps, savePending } = mk();
		const out = await executeSetPrimaryBot({}, ctx, deps);
		expect(out.card.title).toContain("Ana");
		expect(savePending).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: "c1", payload: expect.objectContaining({ action: "set-primary-bot", primaryBot: { botId: "a", name: "Ana" } }) }),
		);
	});

	it("aceita outro bot por nome e recusa quando já existe principal", async () => {
		const { deps, savePending } = mk();
		await executeSetPrimaryBot({ bot: "bia" }, ctx, deps);
		expect(savePending).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ primaryBot: { botId: "b", name: "Bia" } }) }));
		const withPrimary = mk([{ ...roster[0]!, isPrimary: true }, roster[1]!]);
		await expect(executeSetPrimaryBot({}, ctx, withPrimary.deps)).rejects.toThrow("Já existe");
		await expect(executeSetPrimaryBot({}, { ...ctx, origin: "bot" }, mk().deps)).rejects.toThrow("usuário");
		await expect(executeSetPrimaryBot({}, ctx, mk([roster[0]!]).deps)).rejects.toThrow("só um bot");
	});
});
