"use client";

import { Marker, MarkerContent } from "@workspace/ui/components/marker";

import { type BotMessage, type BotPartner } from "@/lib/bot-thread";
import { useTranslations } from "@/lib/i18n/provider";

import { BotChip, type BotRef } from "./bot-chip";

/**
 * Mensagens consecutivas entre bots (pedidos que chegaram e as falas deste bot
 * ao atendê-los) numa linha só: "N mensagens com [avatar] A". A linha toda abre
 * a conversa entre os dois bots.
 */
export function BotThreadGroup({
	messages,
	partners,
	resolveBot,
	onOpen,
}: {
	messages: readonly BotMessage[];
	partners: readonly BotPartner[];
	resolveBot: (partner: BotPartner) => BotRef;
	/** Abre a conversa com o parceiro; sem ele (bot apagado) a linha é só informativa. */
	onOpen?: () => void;
}) {
	const { t, tn } = useTranslations();
	// "3 mensagens com " + avatares/nome de cada parceiro (separados por vírgula/e).
	const prefix = `${tn("aiElements.bots.group", messages.length)} `;
	const content = (
		<Marker className="justify-center text-xs">
			<MarkerContent className="inline-flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
				<span>{prefix}</span>
				{partners.length === 0 ? (
					<span>{t("aiElements.bots.otherBot")}</span>
				) : (
					partners.map((partner, index) => (
						<span className="inline-flex items-center gap-1" key={partner.id ?? partner.name}>
							{index > 0 ? <span>{index === partners.length - 1 ? t("aiElements.bots.and") : ","}</span> : null}
							<BotChip bot={resolveBot(partner)} />
						</span>
					))
				)}
			</MarkerContent>
		</Marker>
	);
	const names = partners.map((partner) => partner.name).join(", ") || t("aiElements.bots.otherBot");
	return (
		<div className="my-2" data-testid="bot-thread-group">
			{onOpen ? (
				<button
					aria-label={t("aiElements.bots.viewConversationWith", { names })}
					className="block w-full cursor-pointer rounded-full py-0.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={onOpen}
					type="button"
				>
					{content}
				</button>
			) : (
				content
			)}
		</div>
	);
}
