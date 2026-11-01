import { DEFAULT_AUTONOMY_LEVEL, decideAction } from "@workspace/shared";
import { saveSkillPendingIntent, persistConversationCardFromEvent } from "@workspace/db";
import { executeShowImage } from "../../show-image.js";
import { attachmentCopyTarget, executeAttachmentTool } from "../../attachment-tools.js";
import { executeGenerateImage, IMAGE_MODEL_MISSING_MESSAGE, parseGenerateImageArgs } from "../../generate-image.js";
import type { ConfirmEvent, ToolContext, ToolResult } from "../types.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeCreateFile, previewCreateFileArgs } from "../../create-file.js";
import { resolveDeckFileDeps } from "../../deck-file.js";
import { executeInspectPresentation } from "../../inspect-presentation.js";
import { executeRunCode } from "../../run-code.js";

import type { ToolFamily } from "../registry.js";

async function handleAttachmentReadGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const attachments = ctx.attachments;
	if (!attachments || !ctx.userId) throw new Error("Anexos indisponíveis neste run.");
	const dev = ctx.devSession;
	return executeAttachmentTool(name, args, {
		cache: attachments.runtime.cache,
		list: attachments.runtime.list,
		copyTarget: async () => attachmentCopyTarget({
			...(dev ? { devWrite: (path: string, bytes: Uint8Array) => dev.writeBinaryFile(path, bytes) } : {}),
			...(attachments.vmAvailable && ctx.manager.execWriteFile ? { vm: { writeFile: (sessionId: string, writeParams: { path: string; bytes: Uint8Array }) => ctx.manager.execWriteFile!(sessionId, writeParams), getSessionId: () => ctx.getSessionId() } } : {}),
		}),
	});
}

async function handleGenerateImage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.imageGeneration) {
		throw new Error(IMAGE_MODEL_MISSING_MESSAGE);
	}
	if (!ctx.showImages || !ctx.userId || !ctx.conversationId || ctx.origin !== "chat") {
		throw new Error("Geração de imagem indisponível neste run.");
	}
	const parsed = parseGenerateImageArgs(args);
	if (parsed.n > ctx.imageGeneration.remaining() || parsed.n > ctx.showImages.remaining()) {
		throw new Error("Limite de imagens deste run atingido. Peça uma nova geração em outra mensagem.");
	}
	// Geração paga usa a matriz de escrita externa: Equilibrado pergunta,
	// Autônomo executa e Sempre perguntar exige confirmação.
	const decision = decideAction(ctx.autonomy?.get() ?? { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] }, {
		actionClass: "write", tool: "generate_image", host: false,
	});
	if (decision === "block") throw new Error("Geração de imagem bloqueada pela autonomia do usuário.");
	if (decision === "ask") {
		const confirmId = `confirm-${ctx.runId ?? "local"}`;
		await saveSkillPendingIntent({
			userId: ctx.userId, conversationId: ctx.conversationId,
			payload: { kind: "confirm", action: "generate-image", confirmId, botId: ctx.botId,
				imageGeneration: { prompt: parsed.prompt, n: parsed.n, runId: ctx.runId ?? "local", ...(parsed.aspectRatio ? { aspectRatio: parsed.aspectRatio } : {}) } },
		});
		const card: ConfirmEvent = { type: "confirm", confirmId, title: "Gerar imagem?", description: `O modelo de imagem pode cobrar por ${parsed.n} imagem(ns).`, confirmLabel: "Gerar", cancelLabel: "Cancelar" };
		await persistConversationCardFromEvent(ctx.conversationId, card);
		return { summary: "Card de confirmação de custo enviado. Aguarde a escolha do usuário; não repita a geração.", confirmEvent: card };
	}
	const result = await executeGenerateImage(parsed, {
		apiKey: ctx.imageGeneration.apiKey, model: ctx.imageGeneration.model,
		userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId,
		signal: ctx.abortSignal, onImages: ctx.showImages.emit,
		onCost: ctx.imageGeneration.onCost,
	});
	ctx.imageGeneration.add(result.count);
	ctx.showImages.add(result.count);
	return { summary: result.summary };
}

async function handleShowImage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.userId || !ctx.showImages) throw new Error("Imagem indisponível neste run.");
	const result = await executeShowImage(args, {
		userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId,
		manager: ctx.manager, getSessionId: ctx.getSessionId,
		remaining: ctx.showImages.remaining(), onImages: ctx.showImages.emit,
	});
	ctx.showImages.add(result.count);
	return { summary: result.summary };
}

async function handleCreateFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Partes intermediárias (more=true) só guardam texto: portão e verificação valem na parte final, com o arquivo inteiro.
	if (args.more !== true) {
		ctx.deliveryGate?.check("create_file");
		ctx.deliverableVerifier?.verify(previewCreateFileArgs(args, { ...ctx, signal: ctx.abortSignal }));
	}
	const runtime = ctx.attachments?.runtime;
	return executeCreateFile(args, { ...ctx, signal: ctx.abortSignal, canSeeImages: ctx.canSeeImages, attachmentFiles: runtime ? { list: () => runtime.list(), bytes: (id: string) => runtime.cache.bytes(id) } : undefined }, ctx.createFileDeps);
}

async function handleInspectPresentation(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const runtime = ctx.attachments?.runtime;
	return executeInspectPresentation(
		args,
		{ ...ctx, signal: ctx.abortSignal, canSeeImages: ctx.canSeeImages, attachmentFiles: runtime ? { list: () => runtime.list(), bytes: (id: string) => runtime.cache.bytes(id) } : undefined },
		resolveDeckFileDeps(ctx.createFileDeps),
	);
}

async function handleRunCode(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const attachments = ctx.attachments?.runtime;
	const startedAt = new Date();
	// Cartão "Executou código": grava código, saída truncada e status; vale também quando a execução falha.
	const persistRunCodeCard = async (card: { ok: boolean; durationMs?: number; output: string }) => {
		if (!ctx.toolCallId || typeof args.code !== "string" || !args.code.trim()) return;
		await persistConversationCardFromEvent(ctx.conversationId, {
			type: "code-run",
			callId: ctx.toolCallId,
			code: args.code,
			status: card.ok ? "ok" : "error",
			...(card.durationMs !== undefined ? { durationMs: card.durationMs } : {}),
			output: card.output,
			startedAt: startedAt.toISOString(),
			...(ctx.runId ? { runId: ctx.runId } : {}),
		}).catch(() => undefined);
	};
	let outcome: Awaited<ReturnType<typeof executeRunCode>>;
	try {
		outcome = await executeRunCode(args, {
		signal: ctx.abortSignal,
		userId: ctx.userId,
		runId: ctx.runId,
		conversationId: ctx.conversationId,
		showImages: ctx.showImages,
		emitFile: ctx.emitFile,
		emitChart: ctx.emitChart,
		...(ctx.toolCallId ? { callId: ctx.toolCallId } : {}),
		canSeeImages: ctx.canSeeImages,
		...(attachments ? { attachments: { list: () => attachments.list(), bytes: (id: string) => attachments.cache.bytes(id) } } : {}),
		}, ctx.runCodeDeps);
	} catch (error) {
		await persistRunCodeCard({ ok: false, output: error instanceof Error ? error.message : "erro" });
		throw error;
	}
	await persistRunCodeCard({ ok: outcome.codeRun.ok, durationMs: outcome.codeRun.durationMs, output: outcome.codeRun.output });
	return { summary: outcome.summary, visionArtifactIds: outcome.visionArtifactIds };
}

/** Família `files`. */
export const FILES_TOOLS: ToolFamily = {
	"attachment_read": { group: "files", handler: (args, ctx) => handleAttachmentReadGroup("attachment_read", args, ctx) },
	"attachment_list": { group: "files", handler: (args, ctx) => handleAttachmentReadGroup("attachment_list", args, ctx) },
	"attachment_to_computer": { group: "files", handler: (args, ctx) => handleAttachmentReadGroup("attachment_to_computer", args, ctx) },
	"generate_image": { group: "files", handler: handleGenerateImage },
	"show_image": { group: "files", handler: handleShowImage },
	"create_file": { group: "files", handler: handleCreateFile },
	"inspect_presentation": { group: "files", handler: handleInspectPresentation },
	"run_code": { group: "files", handler: handleRunCode },
};
