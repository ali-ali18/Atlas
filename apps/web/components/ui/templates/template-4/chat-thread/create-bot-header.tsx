"use client";

import { useEffect, useRef, useState } from "react";

import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@workspace/ui/components/input-group";

import { useTranslations } from "@/lib/i18n/provider";
import { defaultBodyColor, type NewBotInput } from "../data";
import { usePreviewExpression } from "../use-preview-expression";
import { AgentAvatar } from "../agent-avatar";

/** Nome do novo bot no topo da conversa vazia. Grupos têm o próprio diálogo ("Novo grupo"). */
export function CreateBotHeader({
	onCancel,
	onCreate,
}: {
	onCancel: () => void;
	onCreate: (input: NewBotInput) => void;
}) {
	const { t } = useTranslations();
	const [name, setName] = useState("");
	const { expression, surpriseOnHover, releaseHover, surpriseOnTap } = usePreviewExpression();
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const id = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(id);
	}, []);

	return (
		<form
			className="flex w-full items-center gap-1"
			data-create-bot
			onSubmit={(event) => {
				event.preventDefault();
				onCreate({ name: name.trim() || t("groups.createBot.defaultName") });
			}}
		>
			{/* Fundo opaco: o padrão (bg-input/50) é translúcido e, no cabeçalho flutuante do desktop, a conversa aparecia por trás. */}
			<InputGroup className="mx-auto h-8 w-full max-w-2xl border-border bg-card shadow-sm">
				<InputGroupAddon onClick={surpriseOnTap} onPointerEnter={surpriseOnHover} onPointerLeave={releaseHover}>
					<AgentAvatar bodyColor={defaultBodyColor} size={18} mood={expression} />
				</InputGroupAddon>
				<InputGroupInput
					aria-label={t("groups.createBot.nameLabel")}
					onBlur={onCancel}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("groups.createBot.nameLabel")}
					ref={inputRef}
					value={name}
				/>
			</InputGroup>
		</form>
	);
}
