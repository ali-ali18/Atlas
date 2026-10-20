"use client";

import {
	ChevronLeftIcon,
	ClockIcon,
	CopyIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
	WebhookIcon,
	XIcon,
} from "lucide-react";
import {
	type Dispatch,
	type MutableRefObject,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@workspace/ui/components/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@workspace/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@workspace/ui/components/select";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import {
	GITHUB_TRIGGER_EVENT_GROUPS,
	GITHUB_TRIGGER_EVENT_META,
	GITHUB_TRIGGER_EVENTS,
	describeGithubTriggerClauses,
	isGithubCiEvent,
	type RoutineRunRecord,
} from "@workspace/shared";
import {
	getGithubStatus,
	listGithubBranches,
	listGithubPulls,
	listGithubRepos,
	type GithubBranchOption,
	type GithubPullOption,
	type GithubRepoOption,
	type GithubStatus,
} from "@/lib/atlas-api";
import type { Routine, RoutineGithubUiConfig } from "../data";
import { hoverRevealClass } from "@/lib/hover-reveal";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/openrouter-models";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { ModelPicker } from "@/components/model-picker";
import { SettingsPicker } from "../settings-picker";
import { GithubMarkIcon } from "@/components/icons/github-mark";
import { markdownComponents } from "../chat-thread/assistant-message";
import {
	DEFAULT_SCHEDULE,
	ScheduleEditor,
	type ScheduleState,
	scheduleLabel,
} from "./schedule-editor";
import { formatRoutineRunTime, routineRunLabel } from "./routine-map";
import {
	canAutosaveRoutine,
	createDebouncedSaver,
	isRoutineDraftValid,
} from "./routine-draft";

const DEFAULT_GITHUB_CONFIG: RoutineGithubUiConfig = {
	repo: "",
	events: ["pr_opened"],
	prNumber: "",
	users: "",
	ciBranch: "",
};

/** Combobox de repositório: busca debounced em /v1/github/repos?q= ao abrir/digitar. */
export function GithubRepoField({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (repo: string) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState(value);
	const [options, setOptions] = useState<GithubRepoOption[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!open) setQuery(value);
	}, [value, open]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		const timer = window.setTimeout(() => {
			listGithubRepos(query)
				.then((repos) => {
					if (!cancelled) setOptions(repos);
				})
				.catch(() => {
					if (!cancelled) setOptions([]);
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 300);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [open, query]);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				className="flex h-9 w-full items-center justify-between gap-2 rounded-3xl border border-transparent bg-input/50 px-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
				disabled={disabled}
			>
				<span className="truncate">{value || "Buscar repositório…"}</span>
				<SearchIcon className="size-4 shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-(--anchor-width) p-0" side="bottom">
				<Command shouldFilter={false}>
					<CommandInput
						onValueChange={setQuery}
						placeholder="owner/repo"
						value={query}
					/>
					<CommandList>
						<CommandEmpty>
							{loading ? "Buscando…" : "Nenhum repositório encontrado."}
						</CommandEmpty>
						<CommandGroup>
							{options.map((repo) => (
								<CommandItem
									key={repo.fullName}
									onSelect={() => {
										onChange(repo.fullName);
										setOpen(false);
									}}
									value={repo.fullName}
								>
									<span className="truncate">{repo.fullName}</span>
									{repo.private ? (
										<span className="ml-auto shrink-0 text-muted-foreground text-xs">
											privado
										</span>
									) : null}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function EventChip({
	label,
	selected,
	onClick,
}: {
	label: string;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			aria-pressed={selected}
			className={cn(
				"rounded-full border px-2.5 py-1 text-xs transition-colors",
				selected
					? "border-primary bg-primary text-primary-foreground"
					: "border-border bg-transparent text-muted-foreground hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

const GROUP_NONE_VALUE = "none";
const GROUP_NEW_VALUE = "__new__";

const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
	const hours = Math.floor(index / 4);
	const minutes = (index % 4) * 15;
	return `${hours}:${String(minutes).padStart(2, "0")}`;
});

const SCHEDULE_TIME_PRESETS = [
	{ id: "daily", label: "Todos os dias" },
	{ id: "weekdays", label: "Dias úteis" },
	{ id: "weekly", label: "Toda semana" },
	{ id: "monthly", label: "Todos os meses" },
];

type SelectedTrigger = {
	uid: string;
	id: string;
	value: string;
	schedule?: ScheduleState;
};

function triggerPhrase(id: string) {
	if (id === "schedule") return "chegar o horário agendado";
	if (id === "webhook") return "receber um webhook";
	if (id === "github") return "algo acontecer no repositório GitHub";
	if (id === "once") return "chegar a data/hora do lembrete";
	if (id === "interval") return "passar o intervalo configurado";
	return "";
}

/**
 * `useState` que também marca `dirtyRef` a cada mudança pedida pelo usuário
 * (setter "sujo"). O 3º item do tuplo é o setter "cru", que NÃO suja o
 * ref — usado só pra resincronizar com o servidor (nunca dispara autosave).
 * Sem isso, o autosave (efeito abaixo) não teria como distinguir "usuário
 * editou" de "montou"/"prop trocou de identidade" — a causa da rotina
 * reescrever dado velho por cima da edição do agente.
 */
function useDirtyState<T>(
	initial: T | (() => T),
	dirtyRef: MutableRefObject<boolean>,
): [T, Dispatch<SetStateAction<T>>, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState(initial);
	const setDirty = useCallback<Dispatch<SetStateAction<T>>>(
		(next) => {
			dirtyRef.current = true;
			setValue(next);
		},
		[dirtyRef],
	);
	return [value, setDirty, setValue];
}

export function RoutineEditor({
	onClose,
	onSave,
	onCreate,
	onDelete,
	onRotateSecret,
	onOpenMarketplace,
	onEditWithAgent,
	onSaveGithubTrigger,
	persisted = false,
	routine,
	runs = [],
	defaultModel,
	oneTimeSecret,
	groups = [],
	onCreateGroup,
}: {
	onClose?: () => void;
	/** Rotina já criada: autosave (debounced / blur / fechar). */
	onSave?: (routine: Routine) => void | Promise<void>;
	/** Rascunho: só cria no clique em "Criar rotina". Retorna `false` se falhou. */
	onCreate?: (routine: Routine) => Promise<boolean> | boolean;
	onDelete?: () => void;
	onRunNow?: () => void;
	onRotateSecret?: () => void;
	/** Abre o dialog do Marketplace (conectar GitHub etc). */
	onOpenMarketplace?: () => void;
	/** Foca o composer prefiltrado para ajustar a rotina pelo chat; fecha o overlay. */
	onEditWithAgent?: (routine: Routine) => void;
	/** Salva só o gatilho GitHub (botão explícito — evita ressincronizar o webhook a cada autosave). */
	onSaveGithubTrigger?: (
		github: RoutineGithubUiConfig,
	) => Promise<RoutineGithubUiConfig | { error: string }>;
	persisted?: boolean;
	routine?: Routine;
	runs?: RoutineRunRecord[];
	running?: boolean;
	defaultModel?: string;
	oneTimeSecret?: string | null;
	/** Grupos existentes do bot (campo "Grupo"). */
	groups?: Array<{ id: string; name: string }>;
	/** Cria um grupo novo; devolve o grupo ou a mensagem de erro. */
	onCreateGroup?: (name: string) => Promise<{ id: string; name: string } | { error: string }>;
}) {
	const { models, loading } = useOpenRouterModels();
	const initialModel =
		routine?.model?.trim() ||
		defaultModel?.trim() ||
		DEFAULT_OPENROUTER_MODEL;
	/**
	 * Sujo = usuário mexeu em algo desde o último sync com o servidor. Só
	 * quando sujo o autosave dispara — nunca no mount, nunca só porque a
	 * prop `routine` trocou de identidade (agente editando por fora, reload
	 * da lista etc.).
	 */
	const dirtyRef = useRef(false);
	const [active, setActive, setActiveRaw] = useDirtyState(
		routine?.active ?? true,
		dirtyRef,
	);
	const [name, setName, setNameRaw] = useDirtyState(
		routine?.name ?? "",
		dirtyRef,
	);
	const [instruction, setInstruction, setInstructionRaw] = useDirtyState(
		routine?.instruction ?? "",
		dirtyRef,
	);
	const [model, setModel, setModelRaw] = useDirtyState(initialModel, dirtyRef);
	const [groupId, setGroupId, setGroupIdRaw] = useDirtyState<string | null>(routine?.groupId ?? null, dirtyRef);
	const [newGroupName, setNewGroupName] = useState<string | null>(null);
	const [newGroupError, setNewGroupError] = useState<string | null>(null);
	const [newGroupSaving, setNewGroupSaving] = useState(false);
	const [allowChatgptPlan, setAllowChatgptPlan, setAllowChatgptPlanRaw] = useDirtyState(routine?.allowChatgptPlan ?? false, dirtyRef);
	const [triggerKind, setTriggerKind, setTriggerKindRaw] = useDirtyState<
		"cron" | "event" | "once" | "interval"
	>(routine?.triggerKind ?? "cron", dirtyRef);
	const [triggers, setTriggers, setTriggersRaw] = useDirtyState<
		SelectedTrigger[]
	>(
		() =>
			routine?.triggers.map((trigger) => ({
				uid: crypto.randomUUID(),
				id: trigger.id,
				value: trigger.text,
				schedule: trigger.schedule,
			})) ?? [],
		dirtyRef,
	);
	const [openUid, setOpenUid] = useState<string | null>(null);
	const [id] = useState(() => routine?.id ?? crypto.randomUUID());
	const [copied, setCopied] = useState<"url" | "secret" | "urlSecret" | null>(null);
	const [githubConfig, setGithubConfig, setGithubConfigRaw] =
		useDirtyState<RoutineGithubUiConfig>(
			() => routine?.github ?? DEFAULT_GITHUB_CONFIG,
			dirtyRef,
		);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [githubSaving, setGithubSaving] = useState(false);
	const [githubSaveError, setGithubSaveError] = useState<string | null>(null);

	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const skipSaveRef = useRef(false);

	const isGithubTrigger = triggers[0]?.id === "github";

	const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
	const [githubStatusLoading, setGithubStatusLoading] = useState(false);
	const [githubPulls, setGithubPulls] = useState<GithubPullOption[]>([]);
	const [githubPullsLoading, setGithubPullsLoading] = useState(false);
	const [githubBranches, setGithubBranches] = useState<GithubBranchOption[]>([]);
	const [githubBranchesLoading, setGithubBranchesLoading] = useState(false);

	const hasCiEvent = githubConfig.events.some((event) => isGithubCiEvent(event));
	const needsCiBranch = hasCiEvent && !githubConfig.prNumber.trim();

	useEffect(() => {
		if (!isGithubTrigger) return;
		let cancelled = false;
		setGithubStatusLoading(true);
		getGithubStatus()
			.then((status) => {
				if (!cancelled) setGithubStatus(status);
			})
			.catch(() => {
				if (!cancelled) setGithubStatus({ connected: false });
			})
			.finally(() => {
				if (!cancelled) setGithubStatusLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isGithubTrigger]);

	useEffect(() => {
		const repo = githubConfig.repo.trim();
		if (!isGithubTrigger || !repo) {
			setGithubPulls([]);
			return;
		}
		let cancelled = false;
		setGithubPullsLoading(true);
		listGithubPulls(repo)
			.then((items) => {
				if (!cancelled) setGithubPulls(items);
			})
			.catch(() => {
				if (!cancelled) setGithubPulls([]);
			})
			.finally(() => {
				if (!cancelled) setGithubPullsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isGithubTrigger, githubConfig.repo]);

	useEffect(() => {
		const repo = githubConfig.repo.trim();
		if (!isGithubTrigger || !needsCiBranch || !repo) {
			setGithubBranches([]);
			return;
		}
		let cancelled = false;
		setGithubBranchesLoading(true);
		listGithubBranches(repo)
			.then((items) => {
				if (!cancelled) setGithubBranches(items);
			})
			.catch(() => {
				if (!cancelled) setGithubBranches([]);
			})
			.finally(() => {
				if (!cancelled) setGithubBranchesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isGithubTrigger, needsCiBranch, githubConfig.repo]);

	function buildRoutine(): Routine {
		return {
			id,
			name: name.trim(),
			instruction,
			active,
			model,
			allowChatgptPlan,
			...(groupId !== null || routine?.groupId ? { groupId } : {}),
			triggerKind,
			triggers: triggers.map((trigger) => ({
				id: trigger.id,
				schedule: trigger.schedule,
				text: trigger.schedule
					? scheduleLabel(trigger.schedule)
					: trigger.value || triggerPhrase(trigger.id),
			})),
			hook: routine?.hook,
			github: isGithubTrigger ? githubConfig : routine?.github,
		};
	}

	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
		"idle",
	);
	const mountedRef = useRef(true);
	const textEditRef = useRef(false);
	const saverRef = useRef<ReturnType<typeof createDebouncedSaver<Routine>>>(
		null as never,
	);
	if (!saverRef.current) {
		saverRef.current = createDebouncedSaver<Routine>((next) => {
			const result = onSaveRef.current?.(next);
			const done = () => {
				if (mountedRef.current && !saverRef.current.hasPending()) {
					setSaveStatus("saved");
				}
			};
			if (result && typeof result.then === "function") {
				result.then(done, () => {
					if (mountedRef.current) setSaveStatus("idle");
				});
			} else {
				done();
			}
		});
	}

	// Fechar/desmontar: não perde a última edição.
	useEffect(() => {
		mountedRef.current = true;
		const saver = saverRef.current;
		return () => {
			mountedRef.current = false;
			saver.flush();
		};
	}, []);

	// Autosave SÓ para rotina já criada. Texto (nome/instrução): debounce de
	// >=1.2s ou blur; controles discretos (select, toggle, agenda): na hora.
	// Rascunho NUNCA cria no servidor aqui — só no botão "Criar rotina".
	//
	// Só roda depois de uma mudança do USUÁRIO (`dirtyRef`) — nunca no mount
	// nem só porque a prop `routine` trocou de identidade (reload da lista,
	// agente editando por fora etc). O gatilho GitHub NUNCA entra aqui (só via
	// "Salvar gatilho").
	useEffect(() => {
		if (!persisted) return;
		if (skipSaveRef.current) return;
		if (!dirtyRef.current) return;
		dirtyRef.current = false;
		const immediate = !textEditRef.current;
		textEditRef.current = false;
		if (!canAutosaveRoutine({ name })) return;
		setSaveStatus("saving");
		saverRef.current.schedule(buildRoutine(), immediate);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		persisted,
		active,
		id,
		instruction,
		model,
		allowChatgptPlan,
		groupId,
		name,
		triggerKind,
		triggers,
		routine?.hook,
		routine?.github,
		isGithubTrigger,
		githubConfig,
	]);

	const draftValid = isRoutineDraftValid({ name, instruction, triggers });
	const [creating, setCreating] = useState(false);
	const [createFailed, setCreateFailed] = useState(false);
	const createLockRef = useRef(false);

	async function handleCreate() {
		if (persisted || createLockRef.current || !draftValid) return;
		createLockRef.current = true;
		setCreating(true);
		setCreateFailed(false);
		try {
			const ok = await onCreate?.(buildRoutine());
			if (ok === false && mountedRef.current) setCreateFailed(true);
		} catch {
			if (mountedRef.current) setCreateFailed(true);
		} finally {
			createLockRef.current = false;
			if (mountedRef.current) setCreating(false);
		}
	}

	// Resync com o servidor: quando a prop `routine` chega numa instância nova
	// (reload da lista após o agente editar por fora, por exemplo) E o
	// usuário não está com uma edição pendente, adota os campos frescos nos
	// setters "crus" (não sujam `dirtyRef`, não disparam o autosave acima).
	// Se estiver sujo, não pisa na edição em andamento — o próximo autosave
	// do usuário manda o dado dele mesmo assim.
	const lastSyncedRoutineRef = useRef(routine);
	useEffect(() => {
		if (routine === lastSyncedRoutineRef.current) return;
		lastSyncedRoutineRef.current = routine;
		if (dirtyRef.current) return;
		if (!routine) return;
		setActiveRaw(routine.active);
		setAllowChatgptPlanRaw(routine.allowChatgptPlan ?? false);
		setGroupIdRaw(routine.groupId ?? null);
		setNameRaw(routine.name);
		setInstructionRaw(routine.instruction);
		setModelRaw(
			routine.model?.trim() || defaultModel?.trim() || DEFAULT_OPENROUTER_MODEL,
		);
		setTriggerKindRaw(routine.triggerKind ?? "cron");
		setTriggersRaw(
			routine.triggers.map((trigger) => ({
				uid: crypto.randomUUID(),
				id: trigger.id,
				value: trigger.text,
				schedule: trigger.schedule,
			})),
		);
		setGithubConfigRaw(routine.github ?? DEFAULT_GITHUB_CONFIG);
	}, [
		routine,
		defaultModel,
		setActiveRaw,
		setNameRaw,
		setInstructionRaw,
		setModelRaw,
		setGroupIdRaw,
		setTriggerKindRaw,
		setTriggersRaw,
		setGithubConfigRaw,
	]);

	function addTrigger(trigger: Omit<SelectedTrigger, "uid">) {
		const uid = crypto.randomUUID();
		setTriggerKind(trigger.id === "webhook" ? "event" : "cron");
		setTriggers([{ ...trigger, uid }]);
		window.setTimeout(() => setOpenUid(uid), 0);
	}

	function updateTrigger(uid: string, patch: Partial<SelectedTrigger>) {
		setTriggers((previous) =>
			previous.map((trigger) =>
				trigger.uid === uid ? { ...trigger, ...patch } : trigger,
			),
		);
	}

	function removeTrigger(uid: string) {
		setTriggers((previous) =>
			previous.filter((trigger) => trigger.uid !== uid),
		);
		setTriggerKind("cron");
	}

	function triggerMeta(id: string):
		| {
				label: string;
				icon: ReactNode;
				schedule: boolean;
		  }
		| undefined {
		if (id === "schedule") {
			return { label: "Agendado", icon: <ClockIcon />, schedule: true };
		}
		if (id === "webhook") {
			return { label: "Webhook", icon: <WebhookIcon />, schedule: false };
		}
		if (id === "github") {
			return { label: "GitHub", icon: <GithubMarkIcon />, schedule: false };
		}
		if (id === "once") {
			return { label: "Uma vez", icon: <ClockIcon />, schedule: false };
		}
		if (id === "interval") {
			return { label: "Intervalo", icon: <ClockIcon />, schedule: false };
		}
		return undefined;
	}

	async function copyText(kind: "url" | "secret" | "urlSecret", text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 1500);
		} catch {
			// ignore
		}
	}

	async function handleSaveGithubTrigger() {
		if (!onSaveGithubTrigger) return;
		setGithubSaving(true);
		setGithubSaveError(null);
		try {
			const result = await onSaveGithubTrigger(githubConfig);
			if ("error" in result) {
				setGithubSaveError(result.error);
				return;
			}
			// Eco do servidor (já persistido pelo botão "Salvar gatilho"): usa o
			// setter cru — não é uma edição pendente do usuário, não deve suar
			// o autosave genérico de novo.
			setGithubConfigRaw(result);
		} finally {
			setGithubSaving(false);
		}
	}

	const hookUrl = routine?.hook?.url;

	const githubSaveDisabled =
		githubSaving ||
		!githubConfig.repo.trim() ||
		githubConfig.events.length === 0 ||
		(needsCiBranch && !githubConfig.ciBranch.trim());

	const manualEditorContent = (
		<div className="space-y-5">
			<Field>
				<FieldLabel
					className="text-xs text-muted-foreground"
					htmlFor="routine-name"
				>
					Nome
				</FieldLabel>
				<Input
					id="routine-name"
					onBlur={() => saverRef.current.flush()}
				onChange={(event) => {
					textEditRef.current = true;
					setName(event.target.value);
				}}
					placeholder="Dê um nome a esta rotina"
					value={name}
				/>
			</Field>

			<Field>
				<FieldLabel
					className="text-xs text-muted-foreground"
					htmlFor="routine-model"
				>
					Modelo
				</FieldLabel>
				<ModelPicker
					loading={loading}
					models={models}
					onChange={setModel}
					value={model}
				/>
			</Field>

			{groups.length > 0 || onCreateGroup ? (
				<Field>
					<FieldLabel className="text-xs text-muted-foreground">Grupo</FieldLabel>
					<SettingsPicker
						aria-label="Grupo da rotina"
						onChange={(value) => {
							if (value === GROUP_NEW_VALUE) {
								setNewGroupName("");
								setNewGroupError(null);
								return;
							}
							setNewGroupName(null);
							setGroupId(value === GROUP_NONE_VALUE ? null : value);
						}}
						options={[
							{ value: GROUP_NONE_VALUE, label: "Sem grupo" },
							...groups.map((group) => ({ value: group.id, label: group.name })),
							...(onCreateGroup ? [{ value: GROUP_NEW_VALUE, label: "Novo grupo…" }] : []),
						]}
						value={groupId && groups.some((group) => group.id === groupId) ? groupId : GROUP_NONE_VALUE}
					/>
					{newGroupName !== null ? (
						<form
							className="flex flex-col gap-2"
							onSubmit={async (event) => {
								event.preventDefault();
								const nextName = newGroupName.trim();
								if (!nextName || !onCreateGroup || newGroupSaving) return;
								setNewGroupSaving(true);
								setNewGroupError(null);
								const created = await onCreateGroup(nextName);
								if (!mountedRef.current) return;
								setNewGroupSaving(false);
								if ("error" in created) {
									setNewGroupError(created.error);
									return;
								}
								setGroupId(created.id);
								setNewGroupName(null);
							}}
						>
							<Input
								aria-label="Nome do novo grupo"
								autoFocus
								maxLength={80}
								onChange={(event) => setNewGroupName(event.target.value)}
								placeholder="Nome do novo grupo"
								value={newGroupName}
							/>
							{newGroupError ? (
								<p className="text-destructive text-xs" role="alert">
									{newGroupError}
								</p>
							) : null}
							<div className="flex justify-end gap-2">
								<Button onClick={() => setNewGroupName(null)} size="sm" type="button" variant="outline">
									Cancelar
								</Button>
								<Button disabled={!newGroupName.trim() || newGroupSaving} size="sm" type="submit">
									Criar grupo
								</Button>
							</div>
						</form>
					) : null}
				</Field>
			) : null}

			{model.startsWith("chatgpt/") ? <Field><FieldLabel className="text-xs text-muted-foreground">Rotinas usam o plano</FieldLabel><SettingsPicker aria-label="Rotinas usam o plano" value={allowChatgptPlan ? "on" : "off"} onChange={(value) => setAllowChatgptPlan(value === "on")} options={[{ value: "off", label: "Não, usar OpenRouter" }, { value: "on", label: "Sim, usar plano ChatGPT" }]} /><p className="text-xs text-muted-foreground">Desligado por padrão. Ao ativar, execuções automáticas consomem sua cota pessoal.</p></Field> : null}
{!isGithubTrigger ? (
				<div className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs">
						Quando executar
					</p>
					<div className="rounded-2xl border p-1">
						{triggers.map((selected) => {
							const trigger = triggerMeta(selected.id);
							if (!trigger) return null;
							const schedule = selected.schedule;
							return (
								<div
									className="group/trigger relative flex items-center"
									key={selected.uid}
								>
									{trigger.schedule ? (
										<Popover
											onOpenChange={(open) =>
												setOpenUid(open ? selected.uid : null)
											}
											open={openUid === selected.uid}
										>
											<PopoverTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pr-8 pl-2 text-left text-sm transition-colors hover:bg-muted/50">
												<span className="text-muted-foreground [&_svg]:size-4">
													{trigger.icon}
												</span>
												<span className="truncate">
													<span className="text-muted-foreground">Quando </span>
													{schedule
														? scheduleLabel(schedule)
														: selected.value || "…"}
												</span>
											</PopoverTrigger>
											<PopoverContent
												align="start"
												className="w-(--anchor-width) gap-2 p-3"
												side="bottom"
											>
												<PopoverHeader>
													<PopoverTitle className="text-sm">
														{trigger.label}
													</PopoverTitle>
												</PopoverHeader>
												{schedule ? (
													<ScheduleEditor
														onChange={(patch) =>
															updateTrigger(selected.uid, {
																schedule: { ...schedule, ...patch },
															})
														}
														value={schedule}
													/>
												) : null}
											</PopoverContent>
										</Popover>
									) : (
										<div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pr-8 pl-2 text-sm">
											<span className="text-muted-foreground [&_svg]:size-4">
												{trigger.icon}
											</span>
											<span className="truncate">{trigger.label}</span>
										</div>
									)}
									<Button
										aria-label="Remover gatilho"
										className={cn("absolute right-1 text-muted-foreground", hoverRevealClass("trigger"))}
										onClick={() => removeTrigger(selected.uid)}
										size="icon-sm"
										variant="ghost"
									>
										<XIcon />
									</Button>
								</div>
							);
						})}
						<DropdownMenu>
							<DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-muted-foreground text-sm transition-colors hover:text-foreground">
								<PlusIcon className="size-4" />
								{triggers.length === 0
									? "Adicionar gatilho"
									: "Alterar gatilho"}
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								<DropdownMenuItem
									className="gap-2"
									onClick={() =>
										addTrigger({
											id: "webhook",
											value: "Webhook",
										})
									}
								>
									<span className="text-muted-foreground [&_svg]:size-4">
										<WebhookIcon />
									</span>
									Webhook
								</DropdownMenuItem>
								<DropdownMenuSub>
									<DropdownMenuSubTrigger className="gap-2">
										<span className="text-muted-foreground [&_svg]:size-4">
											<ClockIcon />
										</span>
										Agendado
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuItem
											onClick={() =>
												addTrigger({
													id: "schedule",
													value: "",
													schedule: {
														...DEFAULT_SCHEDULE,
														frequency: "hourly",
														minute: ":00",
													},
												})
											}
										>
											A cada hora
										</DropdownMenuItem>
										{SCHEDULE_TIME_PRESETS.map((preset) => (
											<DropdownMenuSub key={preset.id}>
												<DropdownMenuSubTrigger>
													{preset.label}
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent className="max-h-64 overflow-y-auto">
													{TIME_OPTIONS.map((time) => (
														<DropdownMenuItem
															key={time}
															onClick={() =>
																addTrigger({
																	id: "schedule",
																	value: "",
																	schedule: {
																		...DEFAULT_SCHEDULE,
																		frequency: preset.id,
																		time,
																	},
																})
															}
														>
															{time}
														</DropdownMenuItem>
													))}
												</DropdownMenuSubContent>
											</DropdownMenuSub>
										))}
										<DropdownMenuItem
											onClick={() =>
												addTrigger({
													id: "schedule",
													value: "",
													schedule: {
														...DEFAULT_SCHEDULE,
														frequency: "interval",
													},
												})
											}
										>
											Intervalo
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												addTrigger({
													id: "schedule",
													value: "",
													schedule: {
														...DEFAULT_SCHEDULE,
														frequency: "advanced",
													},
												})
											}
										>
											Avançado...
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			) : null}

			{triggerKind === "event" && !isGithubTrigger ? (
				<div className="space-y-2 rounded-2xl border p-3">
					<p className="font-medium text-muted-foreground text-xs">
						Webhook
					</p>
					{hookUrl ? (
						<div className="flex items-center gap-2">
							<code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[11px]">
								{hookUrl}
							</code>
							<Button
								onClick={() => void copyText("url", hookUrl)}
								size="icon-sm"
								variant="ghost"
							>
								<CopyIcon />
							</Button>
							{copied === "url" ? (
								<span className="text-muted-foreground text-xs">
									Copiado
								</span>
							) : null}
						</div>
					) : (
						<p className="text-muted-foreground text-xs">
							{persisted
								? "Gerando URL…"
								: "A URL e o secret são gerados ao criar a rotina."}
						</p>
					)}
					{oneTimeSecret ? (
						<div className="space-y-1 rounded-xl bg-muted/60 p-2">
							<p className="font-medium text-xs">
								Segredo (copie agora — não aparece de novo)
							</p>
							<div className="flex items-center gap-2">
								<code className="min-w-0 flex-1 truncate text-[11px]">
									{oneTimeSecret}
								</code>
								<Button
									onClick={() => void copyText("secret", oneTimeSecret)}
									size="icon-sm"
									variant="ghost"
								>
									<CopyIcon />
								</Button>
							</div>
							<p className="pt-1 text-muted-foreground text-xs">
								Envie no cabeçalho <code>X-Atlas-Hook-Secret</code>. Para ligar ao n8n e similares, peça ao bot: ele usa o segredo por referência, sem você copiar nada.
							</p>
						</div>
					) : null}
					{routine?.hook?.urlSecretAt ? (
						<p className="rounded-xl bg-amber-500/10 p-2 text-xs" data-url-secret-warning>
							Esta integração usa o segredo na URL (?secret=). Prefira o cabeçalho X-Atlas-Hook-Secret.
						</p>
					) : null}
					{persisted ? (
						<Button onClick={onRotateSecret} size="sm" variant="outline">
							Gerar novo segredo
						</Button>
					) : null}
				</div>
			) : null}

			{isGithubTrigger ? (
				<div className="space-y-3 rounded-2xl border p-3">
					<div className="flex items-center justify-between gap-2">
						<p className="font-medium text-muted-foreground text-xs">GitHub</p>
						{githubStatusLoading ? (
							<span className="text-muted-foreground text-xs">
								Verificando conexão…
							</span>
						) : githubStatus?.connected ? (
							<span className="text-muted-foreground text-xs">
								{githubStatus.login ? `Conectado como @${githubStatus.login}` : "GitHub conectado"}{githubStatus.source === "composio" ? " (via Composio)" : ""}
							</span>
						) : (
							<Button onClick={onOpenMarketplace} size="sm" variant="outline">
								Conectar GitHub
							</Button>
						)}
					</div>

					<Field>
						<FieldLabel
							className="text-xs text-muted-foreground"
							htmlFor="github-repo"
						>
							Repositório
						</FieldLabel>
						<GithubRepoField
							onChange={(repo) =>
								setGithubConfig((prev) => ({ ...prev, repo }))
							}
							value={githubConfig.repo}
						/>
					</Field>

					<div className="space-y-2">
						<p className="text-muted-foreground text-xs">Eventos</p>
						{GITHUB_TRIGGER_EVENT_GROUPS.map((group) => {
							const eventsInGroup = GITHUB_TRIGGER_EVENTS.filter(
								(event) => GITHUB_TRIGGER_EVENT_META[event].group === group,
							);
							if (eventsInGroup.length === 0) return null;
							return (
								<div className="space-y-1" key={group}>
									<p className="text-muted-foreground text-[11px] uppercase tracking-wide">
										{group}
									</p>
									<div className="flex flex-wrap gap-1.5">
										{eventsInGroup.map((event) => (
											<EventChip
												key={event}
												label={GITHUB_TRIGGER_EVENT_META[event].label}
												onClick={() =>
													setGithubConfig((prev) => ({
														...prev,
														events: prev.events.includes(event)
															? prev.events.filter((item) => item !== event)
															: [...prev.events, event],
													}))
												}
												selected={githubConfig.events.includes(event)}
											/>
										))}
									</div>
								</div>
							);
						})}
					</div>

					<Collapsible>
						<CollapsibleTrigger className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground">
							Filtros avançados
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-3 pt-3">
							<Field>
								<FieldLabel
									className="text-xs text-muted-foreground"
									htmlFor="github-pr"
								>
									PR (opcional)
								</FieldLabel>
								<Select
									onValueChange={(value) =>
										setGithubConfig((prev) => ({
											...prev,
											prNumber: value === "none" ? "" : (value ?? ""),
										}))
									}
									value={githubConfig.prNumber || "none"}
								>
									<SelectTrigger id="github-pr">
										<SelectValue
											placeholder={
												githubPullsLoading ? "Carregando…" : "Nenhum (todos os PRs)"
											}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">Nenhum (todos os PRs)</SelectItem>
										{githubPulls.map((pr) => (
											<SelectItem key={pr.number} value={String(pr.number)}>
												#{pr.number} {pr.title}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									A rotina se apaga quando o PR fechar.
								</p>
							</Field>

							{needsCiBranch ? (
								<Field>
									<FieldLabel
										className="text-xs text-muted-foreground"
										htmlFor="github-ci-branch"
									>
										Branch de CI (obrigatório)
									</FieldLabel>
									<Select
										onValueChange={(value) =>
											setGithubConfig((prev) => ({ ...prev, ciBranch: value ?? "" }))
										}
										value={githubConfig.ciBranch}
									>
										<SelectTrigger id="github-ci-branch">
											<SelectValue
												placeholder={
													githubBranchesLoading ? "Carregando…" : "Escolha a branch"
												}
											/>
										</SelectTrigger>
										<SelectContent>
											{githubBranches.map((branch) => (
												<SelectItem key={branch.name} value={branch.name}>
													{branch.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{!githubConfig.ciBranch.trim() ? (
										<p className="text-destructive text-xs">
											Selecione a branch de CI ou informe o número do PR.
										</p>
									) : null}
								</Field>
							) : null}

							<Field>
								<FieldLabel
									className="text-xs text-muted-foreground"
									htmlFor="github-users"
								>
									Autores (opcional)
								</FieldLabel>
								<Input
									id="github-users"
									onChange={(event) =>
										setGithubConfig((prev) => ({ ...prev, users: event.target.value }))
									}
									placeholder="usuario1, usuario2"
									value={githubConfig.users}
								/>
								<p className="text-muted-foreground text-xs">
									CI não passa por esse filtro.
								</p>
							</Field>
						</CollapsibleContent>
					</Collapsible>

					<div className="space-y-2">
						<Button
							disabled={githubSaveDisabled}
							onClick={() => void handleSaveGithubTrigger()}
							size="sm"
						>
							{githubSaving ? "Salvando…" : "Salvar gatilho"}
						</Button>
						{githubSaveError ? (
							<Alert variant="destructive">
								<AlertDescription>{githubSaveError}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Field>
						<FieldLabel
							className="text-xs text-muted-foreground"
							htmlFor="routine-instruction"
						>
							Instrução
						</FieldLabel>
						<Textarea
							className="min-h-24"
							id="routine-instruction"
							onBlur={() => saverRef.current.flush()}
							onChange={(event) => {
								textEditRef.current = true;
								setInstruction(event.target.value);
							}}
							placeholder="O que esta rotina deve fazer a cada execução?"
							value={instruction}
						/>
					</Field>
				</div>
				{manualEditorContent}
				{persisted ? (
					saveStatus !== "idle" ? (
						<p
							aria-live="polite"
							className="text-muted-foreground text-xs"
							data-routine-save-status={saveStatus}
						>
							{saveStatus === "saving" ? "Salvando…" : "Salvo"}
						</p>
					) : null
				) : (
					<div className="space-y-2">
						<Button
							disabled={!draftValid || creating}
							onClick={() => void handleCreate()}
						>
							{creating ? "Criando…" : "Criar rotina"}
						</Button>
						{createFailed ? (
							<Alert variant="destructive">
								<AlertDescription>
									Não foi possível criar a rotina.
								</AlertDescription>
							</Alert>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}
