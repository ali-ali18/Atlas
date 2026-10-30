"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { SHAPE_IDS } from "@workspace/ui/lib/avatar/geometry/shapes";
import { Button } from "@workspace/ui/components/button";
import {
	InputGroup,
	InputGroupInput,
} from "@workspace/ui/components/input-group";
import { cn } from "@workspace/ui/lib/utils";
import { useTranslations } from "@/lib/i18n/provider";
import { avatarColorName } from "./avatar-color-name";
import { usePreviewExpression } from "./use-preview-expression";
import {
	bodyColors,
	defaultBodyColor,
	defaultBotShape,
	type NewBotInput,
} from "./data";
import { AgentAvatar } from "./agent-avatar";

const shapes = SHAPE_IDS;

export function MobileCreateBot({
	onCancel,
	onCreate,
}: {
	onCancel: () => void;
	onCreate: (input: NewBotInput) => Promise<boolean>;
}) {
	const { t } = useTranslations();
	const [name, setName] = useState("");
	const [color, setColor] = useState(defaultBodyColor);
	const [shape, setShape] = useState<string>(defaultBotShape);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const { expression, blink, gaze, surpriseOnTap } = usePreviewExpression();

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		setError("");
		try {
			const created = await onCreate({
				name: trimmed,
				color,
				shape,
			});
			if (!created) setError(t("groups.createBot.error"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<form
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background md:hidden"
			onSubmit={(event) => void submit(event)}
		>
			<header className="flex shrink-0 items-center gap-3 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
				<Button
					aria-label={t("groups.createBot.cancel")}
					className="size-11 rounded-full"
					onClick={onCancel}
					size="icon"
					type="button"
					variant="secondary"
				>
					<XIcon className="size-5" />
				</Button>
				<h1 className="text-lg font-semibold">{t("groups.createBot.title")}</h1>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-5">
				<div className="mx-auto flex min-h-full max-w-md flex-col">
					<div className="flex min-h-32 flex-1 items-center justify-center py-8">
						<button
							aria-label={t("groups.createBot.surprise")}
							className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
							onClick={surpriseOnTap}
							type="button"
						>
							<AgentAvatar
								bodyColor={color}
								shape={shape}
								size={72}
								mood={expression}
							/>
						</button>
					</div>
					<div className="space-y-7 pb-6">
						<InputGroup>
							<InputGroupInput
								aria-label={t("groups.createBot.nameLabel")}
								maxLength={80}
								onChange={(event) => setName(event.target.value)}
								placeholder={t("groups.createBot.namePlaceholder")}
								value={name}
							/>
						</InputGroup>
						<fieldset>
							<legend className="sr-only">{t("groups.createBot.shapeLegend")}</legend>
							<div className="grid grid-cols-5 justify-items-center gap-2">
								{shapes.map((option) => (
									<button
										aria-label={t("groups.createBot.shape", { shape: option })}
										aria-pressed={shape === option}
										className={cn(
											"grid size-12 place-items-center rounded-2xl",
											shape === option && "bg-muted ring-2 ring-ring",
										)}
										key={option}
										onClick={() => setShape(option)}
										type="button"
									>
										<AgentAvatar
											bodyColor={color}
											shape={option}
											animated={false}
											size={36}
											mood="neutre"
										/>
									</button>
								))}
							</div>
						</fieldset>
						<fieldset>
							<legend className="sr-only">{t("groups.createBot.colorLegend")}</legend>
							<div className="grid grid-cols-6 justify-items-center gap-3">
								{bodyColors.map((option) => (
									<button
										aria-label={avatarColorName(option.value, t)}
										aria-pressed={color === option.value}
										className={cn(
											"size-7 rounded-full border border-border ring-offset-2 ring-offset-background",
											color === option.value && "ring-2 ring-ring",
										)}
										key={option.value}
										onClick={() => setColor(option.value)}
										style={{ backgroundColor: option.value }}
										type="button"
									/>
								))}
							</div>
						</fieldset>
					</div>
				</div>
			</div>
			<footer className="shrink-0 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
				{error ? (
					<p className="mb-2 text-center text-sm text-destructive" role="alert">
						{error}
					</p>
				) : null}
				<Button
					className="w-full rounded-full"
					disabled={!name.trim() || saving}
					type="submit"
				>
					{saving ? t("groups.createBot.creating") : t("groups.createBot.create")}
				</Button>
			</footer>
		</form>
	);
}
