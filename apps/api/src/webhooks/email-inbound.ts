import { Hono } from "hono";
import {
	forgetEmailMessage,
	getMailboxById,
	listEmailRoutinesForMailbox,
	linkEmailMessage,
	notifyBlockedSender,
	recordEmailMessage,
	startEmailRun,
	webhookTokenMatches,
	type BotMailboxRecord,
	type StartEmailRunDeps,
} from "@workspace/db";
import { emailService, type EmailService, type WebhookVerification } from "@workspace/agent-runtime";
import type { RoutineQueue } from "@workspace/queue";
import {
	buildEmailEventEnvelope,
	emailTriggerMatches,
	frameInboundEmail,
	isAddressAllowed,
	normalizeEmailAddress,
} from "@workspace/shared";
import { enqueueMatchedRoutineEvents } from "./dispatch.js";

/** Um e-mail com anexos já convertidos em texto cabe folgado em 5 MB. */
const MAX_BODY_BYTES = 5 * 1_048_576;

export type EmailInboundDeps = {
	getMailbox: (id: string) => Promise<BotMailboxRecord | null>;
	service: Pick<EmailService, "webhookSecretOf" | "provider">;
	record: typeof recordEmailMessage;
	link: typeof linkEmailMessage;
	forget: typeof forgetEmailMessage;
	notifyBlocked: typeof notifyBlockedSender;
	startRun: (deps: StartEmailRunDeps, input: Parameters<typeof startEmailRun>[1]) => ReturnType<typeof startEmailRun>;
	runDeps: () => StartEmailRunDeps | null;
	/** Fila das rotinas com gatilho de e-mail; sem ela, e-mail que casa com rotina responde 503 (o provedor reentrega). */
	routineQueue: RoutineQueue | null;
	matchRoutines: typeof listEmailRoutinesForMailbox;
	enqueueRoutines: typeof enqueueMatchedRoutineEvents;
	now?: () => Date;
};

/**
 * Entrada de e-mail (`POST /v1/email/inbound/:mailboxId?t=<token>`). Pública (sem sessão), com DUAS
 * checagens antes de qualquer efeito: (1) o token secreto da URL (guardado só como hash) e (2) a
 * assinatura HMAC-SHA256 do provedor (`X-Signature` sobre "<X-Timestamp>.<corpo>", janela de 5 min)
 * com o segredo da caixa. Idempotente por id da mensagem no provedor. O dono vem da caixa, nunca do
 * corpo. Remetente fora da lista de permitidos: só registra e avisa o dono (o agente não roda).
 */
export function createEmailInboundRoutes(runDeps: () => StartEmailRunDeps | null, deps?: Partial<EmailInboundDeps>) {
	const d: EmailInboundDeps = {
		getMailbox: getMailboxById,
		service: emailService,
		record: recordEmailMessage,
		link: linkEmailMessage,
		forget: forgetEmailMessage,
		notifyBlocked: notifyBlockedSender,
		startRun: startEmailRun,
		runDeps,
		routineQueue: null,
		matchRoutines: listEmailRoutinesForMailbox,
		enqueueRoutines: enqueueMatchedRoutineEvents,
		...deps,
	};
	const app = new Hono();

	app.get("/v1/email/inbound/:mailboxId", (c) => {
		c.header("Allow", "POST");
		return c.json({ error: "Method Not Allowed" }, 405);
	});

	app.post("/v1/email/inbound/:mailboxId", async (c) => {
		const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
		const declared = Number(c.req.header("Content-Length"));
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);
		const rawBody = await c.req.text();
		if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);

		// Caixa desconhecida, token errado e assinatura errada respondem igual: nada de enumerar caixas.
		const mailbox = await d.getMailbox(c.req.param("mailboxId"));
		if (!mailbox || !webhookTokenMatches(mailbox.webhookSecretHash, c.req.query("t"))) return unauthorized();
		const secret = d.service.webhookSecretOf(mailbox);
		if (!secret) return unauthorized();
		const verified: WebhookVerification = d.service.provider.verifyAndParseWebhook({
			rawBody,
			headers: (name) => c.req.header(name),
			secret,
			now: d.now?.(),
		});
		if (!verified.ok) return verified.reason === "bad_payload" ? c.json({ error: "Invalid payload" }, 400) : unauthorized();
		const event = verified.event;
		if (!event) return c.json({ ok: true, ignored: true }, 200);
		if (!mailbox.enabled) return c.json({ ok: true, ignored: "disabled" }, 200);
		if (event.inboxId && event.inboxId !== mailbox.providerInboxId) return unauthorized();

		const from = normalizeEmailAddress(event.from) ?? event.from;
		// Nunca reage a e-mail do próprio endereço (laço de resposta).
		if (from === normalizeEmailAddress(mailbox.address)) return c.json({ ok: true, ignored: "self" }, 200);

		const allowed = isAddressAllowed(mailbox.allowedSenders, from);
		const { created, row } = await d.record({
			mailbox,
			direction: "in",
			providerMessageId: event.providerMessageId,
			threadId: event.threadId,
			from,
			to: event.to,
			subject: event.subject,
			body: event.body,
			status: allowed ? "received" : "blocked",
		});
		if (!created) return c.json({ ok: true, duplicate: true }, 200);
		if (!allowed) {
			await d.notifyBlocked(mailbox, from, row.id);
			return c.json({ ok: true, blocked: true }, 200);
		}

		// Rotinas com gatilho de e-mail da MESMA caixa (dono e bot vêm da caixa) e filtros que casam: a rotina
		// assume o e-mail (o agente de conversa não responde em paralelo). Só chega aqui remetente permitido.
		const routines = (await d.matchRoutines(mailbox)).filter((item) => emailTriggerMatches(item.trigger, { from, subject: event.subject }));
		if (routines.length > 0) {
			try {
				if (!d.routineQueue) throw new Error("fila de rotinas indisponível");
				const envelope = buildEmailEventEnvelope({
					mailboxId: mailbox.id,
					providerMessageId: event.providerMessageId,
					from,
					subject: event.subject,
					threadId: event.threadId,
					body: event.body,
					attachmentNames: event.attachments?.map((attachment) => attachment.filename),
					occurredAt: (d.now?.() ?? new Date()).toISOString(),
				});
				const runs = await d.enqueueRoutines(d.routineQueue, routines, envelope);
				if (runs.length === 0) throw new Error("nenhuma rotina enfileirada");
				return c.json({ ok: true, routines: runs.length }, 200);
			} catch (error) {
				console.error("email inbound: falha ao disparar rotinas", error instanceof Error ? error.message : "erro");
				await d.forget(row.id).catch(() => undefined);
				return c.json({ error: "Não foi possível iniciar a rotina" }, 503);
			}
		}

		const startDeps = d.runDeps();
		if (!startDeps) {
			await d.forget(row.id);
			return c.json({ error: "Fila de execução indisponível" }, 503);
		}
		try {
			const started = await d.startRun(startDeps, {
				mailbox,
				subject: event.subject,
				framedText: frameInboundEmail({ from, subject: event.subject, threadId: event.threadId, body: event.body, attachments: event.attachments }),
			});
			if (!started) {
				await d.forget(row.id);
				return c.json({ error: "Bot indisponível" }, 503);
			}
			await d.link(row.id, { conversationId: started.conversationId, runId: started.runId });
			return c.json({ ok: true, runId: started.runId, merged: started.merged }, 200);
		} catch (error) {
			console.error("email inbound: falha ao iniciar o run", error instanceof Error ? error.message : "erro");
			await d.forget(row.id).catch(() => undefined);
			// 5xx: o provedor reentrega (até 5 tentativas) e a idempotência não bloqueia, pois o registro foi desfeito.
			return c.json({ error: "Não foi possível iniciar o agente" }, 503);
		}
	});

	return app;
}
