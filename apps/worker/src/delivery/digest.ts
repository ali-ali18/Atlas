import type { DeliveryBatch, DueDelivery } from "@workspace/shared";

/** Texto do e-mail que o usuário lê (pt-BR). Uma mensagem por lote, uma linha por conversa. */

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function itemLine(item: DueDelivery): string {
	const who = item.botName ? `${item.botName}: ` : "";
	if (item.outcome === "failed") {
		return `${who}não consegui concluir. ${item.summary}`.trim();
	}
	if (item.outcome === "budget_exhausted") {
		return `${who}parei no limite de trabalho. ${item.summary}`.trim();
	}
	return `${who}${item.summary || "Terminei o que você pediu."}`.trim();
}

export function buildDeliveryDigest(batch: DeliveryBatch): { subject: string; text: string; html: string } {
	const count = batch.items.length;
	const subject = count === 1 ? "Seu resultado está pronto" : `${count} resultados prontos`;
	const intro = count === 1 ? "Terminei enquanto você estava fora:" : "Terminei estas tarefas enquanto você estava fora:";
	const lines = batch.items.map(itemLine);
	const text = [intro, ...lines.map((line) => `- ${line}`), "", "Abra a conversa para ver o resultado completo."].join("\n");
	const html = [
		`<p>${intro}</p>`,
		`<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`,
		"<p>Abra a conversa para ver o resultado completo.</p>",
	].join("");
	return { subject, text, html };
}
