"use client";

import * as React from "react";

import { Check, MessageCircleQuestionIcon, X } from "lucide-react";

import {
	Questionnaire,
	QuestionnaireActions,
	QuestionnaireChoice,
	QuestionnaireChoiceDescription,
	QuestionnaireChoices,
	QuestionnaireDescription,
	QuestionnaireError,
	QuestionnaireInput,
	QuestionnaireItem,
	QuestionnaireNext,
	QuestionnairePrevious,
	QuestionnaireProgress,
	QuestionnaireSkip,
	QuestionnaireSubmit,
	QuestionnaireTitle,
} from "@workspace/ui/components/questionnaire";

import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";

import type { Message } from "../data";

export type QuestionnaireAnswersMap = Record<string, string | string[]>;

export type QuestionnaireCardMessage = Extract<
	Message,
	{ kind: "questionnaire" }
>;

/**
 * Respostas do FormData -> mapa nome -> valor(es).
 * Choices (radio/checkbox) e Input livre compartilham o mesmo `name`
 * (padrão do BotOnboardingQuestionnaire): `getAll` junta os dois.
 */
export function buildQuestionnaireAnswersMap(
	formData: FormData,
): QuestionnaireAnswersMap {
	const answers: QuestionnaireAnswersMap = {};
	for (const key of new Set(formData.keys())) {
		const values = formData
			.getAll(key)
			.map((value) => String(value).trim())
			.filter(Boolean);
		if (values.length === 0) continue;
		answers[key] = values.length > 1 ? values : (values[0] ?? "");
	}
	return answers;
}

/**
 * Mapa de respostas -> texto da mensagem user enviada via `sendMessage`.
 * Ex.: "direction: both\ndetail: focused\nbriefing: agendar reuniões".
 * Linhas vazias são ignoradas; preserva a ordem dos itens do card
 * quando `order` é fornecido.
 */
export function formatQuestionnaireAnswers(
	answers: QuestionnaireAnswersMap,
	order?: readonly string[],
): string {
	const names = order?.length
		? [...order, ...Object.keys(answers).filter((k) => !order.includes(k))]
		: Object.keys(answers);
	const lines: string[] = [];
	for (const name of names) {
		const value = answers[name];
		if (value === undefined) continue;
		const text = Array.isArray(value) ? value.join(", ") : value;
		const trimmed = text.trim();
		if (!trimmed) continue;
		lines.push(`${name}: ${trimmed}`);
	}
	return lines.join("\n");
}

export function QuestionnaireCard({
	message,
	onSubmit,
	onDismiss,
}: {
	message: QuestionnaireCardMessage;
	onSubmit?: (
		message: QuestionnaireCardMessage,
		answers: QuestionnaireAnswersMap,
	) => void;
	onDismiss?: (message: QuestionnaireCardMessage) => void;
}) {
	const status = message.status ?? "pending";

	if (status === "submitted") {
		// Colapsado: pergunta + opção selecionada/digitada com ✓, sem balão
		// user (as respostas vão ao bot pelo endpoint de submit, silencioso).
		const answers = message.answers ?? {};
		const answered = message.items.filter((item) => {
			const value = answers[item.name];
			if (value === undefined) return false;
			return Array.isArray(value)
				? value.length > 0
				: value.trim().length > 0;
		});
		return (
			<RequestCard
				badge={{ tone: "success", label: "Respondido" }}
				className="max-w-xl"
				detailsLabel="Ver respostas"
				leading={<Check aria-hidden />}
				resolved
				title={message.title}
			>
				{answered.length === 0 ? (
					<p className="m-0 text-muted-foreground text-sm">
						Respostas enviadas — o bot está consolidando.
					</p>
				) : (
					answered.map((item) => {
						const value = answers[item.name];
						const values =
							value === undefined
								? []
								: Array.isArray(value)
									? value
									: [value];
						const labels = values.map(
							(entry) =>
								item.choices?.find((choice) => choice.value === entry)
									?.label ?? entry,
						);
						return (
							<div key={item.name} className="flex min-w-0 flex-col gap-1.5">
								<p className="m-0 text-[13px] font-medium leading-snug">
									{item.prompt}
								</p>
								<div className="flex items-center gap-2 rounded-xl bg-background/70 px-3 py-2 ring-1 ring-foreground/5">
									<span className="min-w-0 flex-1 text-sm text-muted-foreground">
										{labels.join(", ")}
									</span>
									<Check
										aria-label="Respondido"
										className="size-4 shrink-0 text-primary"
									/>
								</div>
							</div>
						);
					})
				)}
			</RequestCard>
		);
	}

	if (status === "dismissed") {
		return (
			<RequestCard
				badge={{ tone: "muted", label: "Dispensado" }}
				className="max-w-xl"
				description="Questionário dispensado sem enviar respostas."
				leading={<X aria-hidden />}
				resolved
				title={message.title}
			/>
		);
	}

	// Espelho `Root.items` <-> `QuestionnaireItem` (atalhos + progresso +
	// validação). O primitive avisa no console quando divergem.
	const rootItems = message.items.map((item) => ({
		name: item.name,
		required: item.required ?? false,
		choices: (item.choices ?? []).map((choice) => ({ value: choice.value })),
	}));

	// Espelho controlado do texto livre por item. O primitive só associa
	// `name` ao campo quando ele está preenchido/selecionado — o espelho
	// garante o digitado no submit mesmo nesse intervalo, sem mudar a
	// semântica (só preenche chaves que o FormData não trouxe).
	const [freeText, setFreeText] = React.useState<Record<string, string>>({});

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formData = new FormData(event.currentTarget);
		const answers = buildQuestionnaireAnswersMap(formData);
		for (const [key, text] of Object.entries(freeText)) {
			if (text.trim() && answers[key] === undefined) {
				answers[key] = text.trim();
			}
		}
		onSubmit?.(message, answers);
	}

	return (
		<RequestCard
			badge={{ tone: "pending", label: "Precisa de você" }}
			className="max-w-xl"
			headerAction={
				onDismiss ? (
					<button
						aria-label="Dispensar questionário"
						className="-my-0.5 -mr-1 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
						onClick={() => onDismiss(message)}
						type="button"
					>
						<X className="size-4" />
					</button>
				) : null
			}
			leading={<MessageCircleQuestionIcon aria-hidden />}
			title={message.title}
		>
			<Questionnaire
				items={rootItems}
				onSubmit={handleSubmit}
				shortcuts="letters"
			>
				{message.items.length > 1 ? <QuestionnaireProgress /> : null}

				{message.items.map((item) => {
					const choices = item.choices ?? [];
					return (
						<QuestionnaireItem
							key={item.name}
							name={item.name}
							required={item.required ?? false}
							multiple={item.multiple ?? false}
						>
							<QuestionnaireTitle className="text-lg">{item.prompt}</QuestionnaireTitle>
							{item.description ? (
								<QuestionnaireDescription>
									{item.description}
								</QuestionnaireDescription>
							) : null}
							{choices.length > 0 ? (
								<QuestionnaireChoices>
									{choices.map((choice) => (
										<QuestionnaireChoice
											key={choice.value}
											value={choice.value}
											className="text-[15px]"
										>
											{choice.label ?? choice.value}
											{choice.description ? (
												<QuestionnaireChoiceDescription>
													{choice.description}
												</QuestionnaireChoiceDescription>
											) : null}
										</QuestionnaireChoice>
									))}
								</QuestionnaireChoices>
							) : null}
							<QuestionnaireInput
								aria-label={item.input?.label ?? item.prompt}
								placeholder={
									item.input?.placeholder ?? "Digite sua própria resposta"
								}
								value={freeText[item.name] ?? ""}
								onChange={(event) =>
									setFreeText((previous) => ({
										...previous,
										[item.name]: event.target.value,
									}))
								}
							/>
							<QuestionnaireError />
							<QuestionnaireActions>
								<QuestionnairePrevious>Voltar</QuestionnairePrevious>
								<QuestionnaireSkip>Pular</QuestionnaireSkip>
								<QuestionnaireNext>Próximo</QuestionnaireNext>
								<QuestionnaireSubmit className={REQUEST_PRIMARY_CLASS}>Enviar</QuestionnaireSubmit>
							</QuestionnaireActions>
						</QuestionnaireItem>
					);
				})}
			</Questionnaire>
		</RequestCard>
	);
}
