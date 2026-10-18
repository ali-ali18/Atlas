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
import { SettingsPicker } from "../settings-picker";

const MODE_LABELS: Record<AutonomyExceptionMode, string> = {
	always_ask: "Sempre perguntar",
	never_ask: "Nunca perguntar",
	blocked: "Bloquear",
};
const MODE_OPTIONS = (
	Object.keys(MODE_LABELS) as AutonomyExceptionMode[]
).map((value) => ({ value, label: MODE_LABELS[value] }));

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
	return (
		<Alert variant="destructive">
			<TriangleAlertIcon />
			<AlertDescription>
				Inclui ações que não dá para desfazer (apagar, enviar, mesclar). O
				agente vai executar sem pedir sua aprovação.
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
			label: `${connection.name} (todas as ações)`,
		})),
		...autonomyToolOptions(scoped).map((option) => ({
			value: `${TOOL_PREFIX}${option.value}`,
			label: option.label,
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
			? autonomyToolLabel(item.tool, labeler)
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
				<span>Exceções ({exceptions.length})</span>
				<ChevronDownIcon
					className={open ? "size-4 rotate-180" : "size-4"}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 space-y-3">
				{visible.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						Nenhuma exceção. Uma exceção vence o nível escolhido.
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
										aria-label={`Modo de ${labelOf(item)}`}
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
										options={MODE_OPTIONS}
										size="sm"
										value={item.mode}
									/>
									<Button
										aria-label={`Remover exceção de ${labelOf(item)}`}
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
						aria-label="Conector ou ação"
						className="w-full"
						onChange={setTarget}
						options={targets}
						placeholder="Escolha um conector ou ação"
						size="sm"
						value={target}
					/>
					<div className="flex items-center gap-2">
						<SettingsPicker
							aria-label="Modo da exceção"
							className="flex-1"
							onChange={setMode}
							options={MODE_OPTIONS}
							size="sm"
							value={mode}
						/>
						<Button
							disabled={disabled || !draft}
							onClick={add}
							size="sm"
							type="button"
						>
							Adicionar
						</Button>
					</div>
					{draftRisky ? <IrreversibleWarning /> : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
