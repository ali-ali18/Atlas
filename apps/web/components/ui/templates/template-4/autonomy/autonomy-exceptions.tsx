"use client";

import { useState } from "react";
import { ChevronDownIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
	autonomyConnectorKey,
	autonomyConnectorLabeler,
	autonomyToolLabel,
	autonomyToolOptions,
	neverAskIsRisky,
	type AutonomyException,
	type AutonomyExceptionMode,
	type McpConnectionView,
} from "@workspace/shared";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { useTranslations } from "@/lib/i18n/provider";
import { SettingsPicker } from "../settings-picker";
import { hostToolLabel, modeLabel } from "./autonomy-copy";

const MODES: readonly AutonomyExceptionMode[] = ["always_ask", "never_ask", "blocked"];

const CONNECTOR_PREFIX = "connector:";
const TOOL_PREFIX = "tool:";

function exceptionKey(item: AutonomyException): string {
	return item.tool
		? `${TOOL_PREFIX}${item.tool}`
		: `${CONNECTOR_PREFIX}${item.connector ?? ""}`;
}

/** A exceção mira este conector (direto ou por uma das tools dele)? */
function targetsConnection(
	item: AutonomyException,
	connection: McpConnectionView,
): boolean {
	if (item.connector) return item.connector === autonomyConnectorKey(connection);
	return autonomyToolOptions([connection]).some(
		(option) => option.value === item.tool,
	);
}

function IrreversibleWarning() {
	const { t } = useTranslations();
	return (
		<Alert variant="destructive">
			<TriangleAlertIcon />
			<AlertDescription>
				{t("autonomy.irreversible")}
			</AlertDescription>
		</Alert>
	);
}

/**
 * Exceções por conector ou tool, recolhidas em "Exceções (N)" (só na conta). Cada mudança
 * regrava a lista inteira (a API substitui `exceptions`).
 */
export function AutonomyExceptions({
	exceptions,
	connections,
	disabled,
	connectorFilter,
	onChange,
}: {
	exceptions: AutonomyException[];
	connections: McpConnectionView[];
	disabled?: boolean;
	/** Chave do conector vindo do Marketplace: abre já filtrado nele. */
	connectorFilter?: string;
	onChange: (next: AutonomyException[]) => void;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const modeOptions = MODES.map((value) => ({ value, label: modeLabel(value, translator) }));
	const filterConnection = connectorFilter
		? connections.find(
				(connection) => autonomyConnectorKey(connection) === connectorFilter,
			)
		: undefined;
	const defaultTarget = connectorFilter
		? `${CONNECTOR_PREFIX}${connectorFilter}`
		: "";
	const [open, setOpen] = useState(!!connectorFilter);
	const [target, setTarget] = useState<string>(defaultTarget);
	const [mode, setMode] = useState<AutonomyExceptionMode>("always_ask");

	const labeler = autonomyConnectorLabeler(connections);
	const scoped = filterConnection ? [filterConnection] : connections;
	const visible = filterConnection
		? exceptions.filter((item) => targetsConnection(item, filterConnection))
		: exceptions;
	const targets = [
		...scoped.map((connection) => ({
			value: `${CONNECTOR_PREFIX}${autonomyConnectorKey(connection)}`,
			label: t("autonomy.allActions", { name: connection.name }),
		})),
		...autonomyToolOptions(scoped).map((option) => ({
			value: `${TOOL_PREFIX}${option.value}`,
			label: hostToolLabel(option.value, translator) ?? option.label,
		})),
	];
	const draft: AutonomyException | null = target
		? target.startsWith(TOOL_PREFIX)
			? { tool: target.slice(TOOL_PREFIX.length), mode }
			: { connector: target.slice(CONNECTOR_PREFIX.length), mode }
		: null;
	const draftRisky = draft ? neverAskIsRisky(draft, connections) : false;

	function labelOf(item: AutonomyException): string {
		return item.tool
			? (hostToolLabel(item.tool, translator) ?? autonomyToolLabel(item.tool, labeler))
			: (labeler(item.connector ?? "") ?? item.connector ?? "");
	}

	function add() {
		if (!draft) return;
		const key = exceptionKey(draft);
		onChange([
			draft,
			...exceptions.filter((item) => exceptionKey(item) !== key),
		]);
		setTarget(defaultTarget);
	}

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-xs text-muted-foreground hover:text-foreground">
				<span>{t("autonomy.exceptions", { count: exceptions.length })}</span>
				<ChevronDownIcon
					className={open ? "size-4 rotate-180" : "size-4"}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 space-y-3">
				{visible.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						{t("autonomy.noExceptions")}
					</p>
				) : (
					<ul className="space-y-2">
						{visible.map((item) => (
							<li className="space-y-2" key={exceptionKey(item)}>
								<div className="flex items-center justify-between gap-2">
									<span className="min-w-0 flex-1 truncate text-sm">
										{labelOf(item)}
									</span>
									<SettingsPicker
										aria-label={t("autonomy.modeOf", { name: labelOf(item) })}
										className="w-44"
										disabled={disabled}
										onChange={(value) =>
											onChange(
												exceptions.map((entry) =>
													exceptionKey(entry) === exceptionKey(item)
														? { ...entry, mode: value }
														: entry,
												),
											)
										}
										options={modeOptions}
										size="sm"
										value={item.mode}
									/>
									<Button
										aria-label={t("autonomy.removeException", { name: labelOf(item) })}
										disabled={disabled}
										onClick={() =>
											onChange(
												exceptions.filter(
													(entry) => exceptionKey(entry) !== exceptionKey(item),
												),
											)
										}
										size="icon-sm"
										type="button"
										variant="ghost"
									>
										<XIcon />
									</Button>
								</div>
								{neverAskIsRisky(item, connections) ? (
									<IrreversibleWarning />
								) : null}
							</li>
						))}
					</ul>
				)}
				<div className="space-y-2">
					<SettingsPicker
						aria-label={t("autonomy.targetLabel")}
						className="w-full"
						onChange={setTarget}
						options={targets}
						placeholder={t("autonomy.targetPlaceholder")}
						size="sm"
						value={target}
					/>
					<div className="flex items-center gap-2">
						<SettingsPicker
							aria-label={t("autonomy.exceptionMode")}
							className="flex-1"
							onChange={setMode}
							options={modeOptions}
							size="sm"
							value={mode}
						/>
						<Button
							disabled={disabled || !draft}
							onClick={add}
							size="sm"
							type="button"
						>
							{t("autonomy.add")}
						</Button>
					</div>
					{draftRisky ? <IrreversibleWarning /> : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
