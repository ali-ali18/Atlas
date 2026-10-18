"use client";

import { BellIcon, BotIcon, ChevronRightIcon, CodeIcon, LanguagesIcon, LayersIcon, SparklesIcon, UserCheckIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { SettingRow, SettingsGroup, SettingsStack } from "@/components/settings/setting-row";
import { ModelPicker } from "@/components/model-picker";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { BOT_LANGUAGE_OPTIONS, DEFAULT_BOT_LANGUAGE } from "@/lib/bot-language";
import { readProactiveSettings } from "@/lib/proactive-settings";
import {
	DECIDE_FOR_OTHER_BOTS_HINT,
	DECIDE_FOR_OTHER_BOTS_LABEL,
	modelDisplayName,
	readCodingModel,
	readDecideForOtherBots,
	readSubagentModel,
	resolveChatgptFallbackModel,
	withCodingModel,
	withDecideForOtherBots,
	withSubagentModel,
} from "@workspace/shared";

import { type Agent, defaultBodyColor, defaultBotShape } from "../data";
import { AutonomySettings } from "../autonomy/autonomy-settings";
import { SettingsPicker } from "../settings-picker";
import { AvatarEditor } from "./avatar-editor";
import { MemoryTab } from "./memory-tab";
import { ProactiveSettingsSection } from "./proactive-settings";

/** Páginas da vista de configurações do bot: a principal e a subvista do modo proativo. */
export type AgentSettingsPage = "main" | "proactive";

/** Título da barra do topo para cada página (a principal é "Configurações"). */
export const AGENT_SETTINGS_TITLES: Record<AgentSettingsPage, string> = {
	main: "Configurações",
	proactive: "Modo proativo",
};

/** "Herdar (…)" do modelo para código: o da conta, ou o modelo normal do bot quando a conta não define. */
export function codingInheritLabel(accountModel: string | undefined, models: readonly { id: string; name: string }[]): string {
	if (!accountModel) return "Igual ao bot";
	const known = models.find((model) => model.id === accountModel);
	return `Herdar (${known ? modelDisplayName(known.name, known.id) : accountModel})`;
}

/** Campo de texto do perfil (Nome, Rótulo): rótulo pequeno em cima; salva ao sair do campo ou com Enter. */
function ProfileField({
	id,
	label,
	value,
	placeholder,
	required = false,
	onCommit,
}: {
	id: string;
	label: string;
	value: string;
	placeholder?: string;
	/** Vazio não vale: volta ao valor anterior. */
	required?: boolean;
	onCommit: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	function commit() {
		const next = draft.trim();
		if (required && !next) {
			setDraft(value);
			return;
		}
		if (next !== value.trim()) onCommit(next);
	}
	return (
		<div className="flex flex-col gap-1">
			<label className="px-2 text-muted-foreground text-xs leading-[18px]" htmlFor={id}>
				{label}
			</label>
			<Input
				className="h-9 text-[13px]"
				id={id}
				onBlur={commit}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						setDraft(value);
						event.currentTarget.blur();
					}
				}}
				placeholder={placeholder}
				value={draft}
			/>
		</div>
	);
}

/**
 * Configurações do bot (vista do painel, estilo Grok): avatar, Nome, Rótulo e um cartão com
 * Modelo, Autonomia, Idioma e Notificações. O bot principal ganha a linha "Modo proativo", que abre
 * a subvista. Tudo vale na hora (sem botão Salvar). A descrição se edita em "Sobre", na visão geral.
 */
export function AgentSettings({
	agent,
	onChange,
	page = "main",
	onOpenPage,
	accountTimezone,
	accountCodingModel,
	memoryRequest,
	onFixMemoryInChat,
}: {
	agent: Agent;
	/** Pedido de fora para abrir a aba Memória (`changes` = rola até "O que mudou"); o nonce muda a cada pedido. */
	memoryRequest?: { nonce: number; section?: "changes" };
	/** "Corrigir no chat": rascunho no campo de mensagem. */
	onFixMemoryInChat?: (draft: string) => void;
	onChange: (patch: Partial<Agent> & { policyJson?: unknown }) => void;
	page?: AgentSettingsPage;
	onOpenPage?: (page: AgentSettingsPage) => void;
	/** Fuso das configurações da conta (padrão do modo proativo). */
	accountTimezone?: string;
	/** "Modelo para código" da conta (o que este bot herda quando não escolhe um). */
	accountCodingModel?: string;
}) {
	const { models, loading } = useOpenRouterModels();
	// policyJson vive no runtime sem campo tipado em Agent (ver bot-to-agent).
	const policyJson = (agent as { policyJson?: unknown }).policyJson;
	const [tab, setTab] = useState<string>("general");
	const [changesFocus, setChangesFocus] = useState(0);
	const memoryNonce = memoryRequest?.nonce;
	const memorySection = memoryRequest?.section;
	useEffect(() => {
		if (!memoryNonce) return;
		setTab("memory");
		if (memorySection === "changes") setChangesFocus(memoryNonce);
	}, [memoryNonce, memorySection]);

	if (page === "proactive" && agent.isPrimary) {
		return (
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))]" data-agent-settings-page="proactive">
				<ProactiveSettingsSection accountTimezone={accountTimezone} agent={agent} onChange={onChange} />
			</div>
		);
	}

	let fallback: string | null;
	try {
		fallback = resolveChatgptFallbackModel(policyJson);
	} catch {
		fallback = null;
	}
	const fallbackOptions = [
		{ value: "__none__", label: "Parar e avisar" },
		...models.map((model) => ({ value: model.id, label: `Usar ${modelDisplayName(model.name, model.id)}` })),
	];
	if (fallback && !fallbackOptions.some((option) => option.value === fallback)) {
		fallbackOptions.push({ value: fallback, label: `Usar ${fallback}` });
	}
	const proactive = readProactiveSettings(policyJson, accountTimezone);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))]" data-agent-settings-page="main">
			<Tabs onValueChange={setTab} value={tab}>
				<TabsList aria-label="Seções das configurações">
					<TabsTrigger value="general">Geral</TabsTrigger>
					<TabsTrigger value="memory">Memória</TabsTrigger>
				</TabsList>
				<TabsContent className="pt-3" value="general">
			<SettingsStack>
				<div className="flex flex-col gap-5">
					<div className="grid place-items-center py-1">
						<AvatarEditor
							botId={agent.id}
							color={agent.color}
							onColorChange={(color) => onChange({ color })}
							onReset={() => onChange({ color: defaultBodyColor, shape: defaultBotShape })}
							onShapeChange={(shape) => onChange({ shape })}
							shape={agent.shape}
						/>
					</div>
					<ProfileField
						id="agent-name"
						label="Nome"
						onCommit={(name) => onChange({ name })}
						placeholder="Nome do bot"
						required
						value={agent.name}
					/>
					<ProfileField
						id="agent-title"
						label="Rótulo"
						onCommit={(snippet) => onChange({ snippet })}
						placeholder="Pesquisa, marketing, admin"
						value={agent.snippet}
					/>
				</div>

				<SettingsGroup>
					<SettingRow
						description="Modelo deste bot. Sem escolha, usa o modelo padrão da conta."
						htmlFor="agent-model"
						icon={BotIcon}
						label="Modelo"
					>
						<ModelPicker
							emptyLabel="Herdar da conta"
							id="agent-model"
							loading={loading}
							models={models}
							onChange={(model) => onChange({ openRouterModel: model })}
							value={agent.openRouterModel ?? ""}
						/>
					</SettingRow>

					{agent.openRouterModel?.startsWith("chatgpt/") ? (
						<SettingRow
							description="O que fazer quando a cota do seu plano ChatGPT acaba."
							htmlFor="agent-chatgpt-fallback"
							icon={LayersIcon}
							label="Se o limite do plano acabar"
						>
							<SettingsPicker
								id="agent-chatgpt-fallback"
								onChange={(value) =>
									onChange({
										policyJson: {
											...(policyJson && typeof policyJson === "object" && !Array.isArray(policyJson) ? policyJson : {}),
											chatgptFallbackModel: value === "__none__" ? null : value,
										},
									})
								}
								options={fallbackOptions}
								value={fallback ?? "__none__"}
							/>
						</SettingRow>
					) : null}

					<SettingRow
						description="Modelo usado pelos subagentes que este bot cria."
						htmlFor="agent-subagent-model"
						icon={WorkflowIcon}
						label="Modelo dos subagentes"
					>
						<ModelPicker
							emptyLabel="Igual ao bot"
							id="agent-subagent-model"
							loading={loading}
							models={models}
							onChange={(model) => onChange({ policyJson: withSubagentModel(policyJson, model || null) })}
							value={readSubagentModel(policyJson) ?? ""}
						/>
					</SettingRow>

					<SettingRow
						description="Entra sozinho quando este bot trabalha numa sessão de código."
						htmlFor="agent-coding-model"
						icon={CodeIcon}
						label="Modelo (código)"
					>
						<ModelPicker
							emptyLabel={codingInheritLabel(accountCodingModel, models)}
							id="agent-coding-model"
							loading={loading}
							models={models}
							onChange={(model) => onChange({ policyJson: withCodingModel(policyJson, model || null) })}
							value={readCodingModel(policyJson) ?? ""}
						/>
					</SettingRow>

					<AutonomySettings botId={agent.id} scope="bot" variant="row" />

					<SettingRow
						caption={<p>{DECIDE_FOR_OTHER_BOTS_HINT}</p>}
						control="inline"
						htmlFor="agent-decide-for-others"
						icon={UserCheckIcon}
						label={DECIDE_FOR_OTHER_BOTS_LABEL}
					>
						<Switch
							checked={readDecideForOtherBots(policyJson)}
							id="agent-decide-for-others"
							onCheckedChange={(checked) => onChange({ policyJson: withDecideForOtherBots(policyJson, checked) })}
						/>
					</SettingRow>

					<SettingRow
						description="Idioma das respostas, cards e lembretes deste bot."
						htmlFor="agent-language"
						icon={LanguagesIcon}
						label="Idioma"
					>
						<SettingsPicker
							id="agent-language"
							onChange={(language) => onChange({ language })}
							options={BOT_LANGUAGE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
							value={agent.language ?? DEFAULT_BOT_LANGUAGE}
						/>
					</SettingRow>

					<SettingRow
						caption={<p>Receba uma notificação quando este bot terminar ou precisar de você.</p>}
						control="inline"
						htmlFor="agent-notifications"
						icon={BellIcon}
						label="Notificações"
					>
						<Switch
							checked={agent.notify ?? true}
							id="agent-notifications"
							onCheckedChange={(checked) => onChange({ notify: checked })}
						/>
					</SettingRow>
				</SettingsGroup>

				{agent.isPrimary ? (
					<SettingsGroup>
						<SettingRow
							caption={<p>O bot fala primeiro: lembra de prazos e sugere rotinas.</p>}
							control="inline"
							description="Abre as opções do modo proativo."
							icon={SparklesIcon}
							label="Modo proativo"
						>
							<Button
								aria-label="Abrir Modo proativo"
								className="gap-1"
								onClick={() => onOpenPage?.("proactive")}
								size="sm"
								variant="ghost"
							>
								{proactive.enabled ? "Ligado" : "Desligado"}
								<ChevronRightIcon aria-hidden className="size-3.5" />
							</Button>
						</SettingRow>
					</SettingsGroup>
				) : null}
			</SettingsStack>
				</TabsContent>
				<TabsContent className="pt-3" value="memory">
					<MemoryTab active={tab === "memory"} botId={agent.id} focusChanges={changesFocus} onFixInChat={onFixMemoryInChat} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
