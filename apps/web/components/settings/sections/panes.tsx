"use client";

import { useState, type ReactNode } from "react";
import { ChevronRightIcon, KeyRoundIcon, PlugIcon, StoreIcon, UnplugIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { useChatgptConnection } from "@/hooks/use-chatgpt-connection";
import { useChatgptProvider } from "@/hooks/use-chatgpt-provider";
import type { SettingsIcon } from "@/components/ui/templates/template-4/settings-picker";
import { SaveIndicator, SettingRow, SettingsGroup, SettingsStack } from "../setting-row";
import type { SettingsSectionId, SettingsShortcutId } from "../settings-registry";
import { AccountSettings } from "./account";
import { ComposioSettings } from "./composio";
import { DevEnvironmentsSettings } from "./dev-environments";
import { GithubAppSettings } from "./github-app";
import { AccountAutonomyGroup, ExecutionSettings } from "./execution";
import { GeneralSettings } from "./general";
import { GroupsCoordinationRow, JevSettings } from "./jev";
import { ModelsSettings } from "./models";
import { ModelTiersSettings, TIER_ITEM_IDS } from "./model-tiers";
import { NotificationsSettings } from "./notifications";
import { DisconnectChatgptDialog, ProvidersSettings } from "./providers";
import { ProviderKeysRows } from "./provider-keys";
import { EmailKeyRowConnected } from "./email-key";
import { SkillsSettings } from "./skills";
import { VaultSettings } from "./vault";
import { ReflectionSettings } from "./reflection";
import { TimezoneSettings } from "./timezone";
import { WorkHoursSettings } from "./work-hours";
import { DiagnosticsSettings } from "./diagnostics";
import { UsageSettings } from "./usage";
import { canDisconnect, providersViewState } from "../providers-state";

type Account = ReturnType<typeof useAccountSettings>;

/** Algum dos itens passa pelo filtro da busca? Grupo sem linha visível não aparece. */
function anyVisible(isVisible: (itemId: string) => boolean, ids: readonly string[]): boolean {
	return ids.some((id) => isVisible(id));
}

/** O hook de conta sem os indicadores por linha: o painel mostra um "Salvo"/erro só. */
function quietAccount(account: Account): Account {
	return { ...account, status: "idle", saveError: null, loadError: null };
}

/** Uma única linha de estado no canto do painel, sem ocupar altura (nada pula quando aparece "Salvo"). */
function PaneStatus({ account }: { account: Account }) {
	return (
		<div className="relative -mb-7 h-0" data-slot="settings-pane-status">
			<div className="absolute -top-[18px] right-2 flex h-4 items-center">
				{account.loadError ? (
					<p className="text-xs text-destructive" role="alert">
						{account.loadError}
					</p>
				) : (
					<SaveIndicator error={account.saveError} status={account.status} />
				)}
			</div>
		</div>
	);
}

/** Conta: quem é o usuário (nome, e-mail) e a sessão (Sair). */
export function ContaPane({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	return (
		<SettingsStack>
			<AccountSettings isVisible={isVisible} />
		</SettingsStack>
	);
}

/** Geral: aparência, idioma dos bots novos e fuso horário dos agendamentos. */
export function GeralPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			{anyVisible(isVisible, ["geral.tema", "geral.idioma"]) ? <GeneralSettings account={quiet} isVisible={isVisible} /> : null}
			<TimezoneSettings account={quiet} isVisible={isVisible} />
			<WorkHoursSettings account={quiet} isVisible={isVisible} />
		</SettingsStack>
	);
}

/** Modelos e contexto: modelo padrão/código, modelos auxiliares e como o agente lida com contexto e tamanho de resposta. */
export function ModelosPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	const main = ["modelos.padrao", "modelos.codigo"];
	const tiers = TIER_ITEM_IDS;
	const auxModels = ["modelos.manutencao", "modelos.visao", "modelos.imagem", "modelos.ditado", "modelos.reserva"];
	const context = ["execucao.memoria", "execucao.economia", "execucao.resposta", "execucao.resultado"];
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			{anyVisible(isVisible, main) ? (
				<ModelsSettings
					account={quiet}
					isVisible={(id) => main.includes(id) && isVisible(id)}
					showKeyNote={false}
					showStatus={false}
					title="Modelos principais"
				/>
			) : null}
			{anyVisible(isVisible, tiers) ? (
				<ModelTiersSettings
					account={quiet}
					isVisible={(id) => tiers.includes(id) && isVisible(id)}
					showStatus={false}
					title="Modelos por dificuldade"
				/>
			) : null}
			{anyVisible(isVisible, auxModels) ? (
				<ModelsSettings
					account={quiet}
					isVisible={(id) => auxModels.includes(id) && isVisible(id)}
					showKeyNote={false}
					showStatus={false}
					title="Modelos auxiliares"
				/>
			) : null}
			{anyVisible(isVisible, context) ? (
				<ExecutionSettings
					account={quiet}
					isVisible={(id) => context.includes(id) && isVisible(id)}
					showStatus={false}
					title="Contexto e respostas"
				/>
			) : null}
		</SettingsStack>
	);
}

/** Provedores e chaves: plano ChatGPT, chaves de API e e-mail dos bots. */
export function ProvedoresPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	const plan = ["provedores.chatgpt", "provedores.conexao"];
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			{anyVisible(isVisible, plan) ? (
				<SettingsGroup title="Plano ChatGPT">
					<ProvidersSettings account={quiet} isVisible={(id) => id !== "provedores.desconectar" && isVisible(id)} />
				</SettingsGroup>
			) : null}
			{anyVisible(isVisible, ["provedores.openrouter", "provedores.anthropic", "provedores.opencode-go", "provedores.openmail", "provedores.desconectar"]) ? (
				<SettingsGroup title="Chaves e contas">
					{isVisible("provedores.openrouter") ? <OpenRouterKeyRow account={account} /> : null}
					<ProviderKeysRows isVisible={isVisible} />
					{isVisible("provedores.openmail") ? <EmailKeyRowConnected /> : null}
					<DisconnectChatgptRow account={account} isVisible={isVisible} />
				</SettingsGroup>
			) : null}
		</SettingsStack>
	);
}

/** Notificações: avisos no celular e aparelhos cadastrados. */
export function NotificacoesPane({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	return (
		<SettingsStack>
			<NotificationsSettings isVisible={isVisible} />
		</SettingsStack>
	);
}

/** Bots: como os bots se comportam (autonomia, grupos, reação) e a reflexão diária do bot principal. */
export function BotsPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			<AccountAutonomyGroup isVisible={isVisible} title="Autonomia" />
			{isVisible("jev.grupos") ? (
				<SettingsGroup title="Grupos de bots">
					<GroupsCoordinationRow account={quiet} isVisible={isVisible} />
				</SettingsGroup>
			) : null}
			{isVisible("execucao.reacao") ? (
				<ExecutionSettings
					account={quiet}
					isVisible={(id) => id === "execucao.reacao" && isVisible(id)}
					showStatus={false}
					title="Conversa"
				/>
			) : null}
			<ReflectionSettings account={quiet} isVisible={isVisible} />
		</SettingsStack>
	);
}

/** Computador: o navegador do agente e os ambientes de código. */
export function ComputadorPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			<ExecutionSettings
				account={quietAccount(account)}
				isVisible={(id) => id === "execucao.navegador" && isVisible(id)}
				showStatus={false}
				title="Navegador"
			/>
			{isVisible("ambientes.lista") ? <DevEnvironmentsSettings /> : null}
		</SettingsStack>
	);
}

function OpenRow({
	label,
	description,
	action,
	icon,
	onOpen,
}: {
	label: string;
	description: string;
	action: string;
	icon: SettingsIcon;
	onOpen: () => void;
}) {
	return (
		<SettingRow control="inline" description={description} icon={icon} label={label}>
			<Button className="gap-1" onClick={onOpen} size="sm" variant="ghost">
				{action}
				<ChevronRightIcon aria-hidden className="size-3.5" />
			</Button>
		</SettingRow>
	);
}

/** Conexões: GitHub, Conectores e MCP (abrem o Marketplace) e Composio. */
export function ConexoesPane({
	isVisible,
	onShortcut,
}: {
	isVisible: (itemId: string) => boolean;
	onShortcut: (id: SettingsShortcutId) => void;
}) {
	return (
		<SettingsStack>
			{isVisible("github.app") ? <GithubAppSettings /> : null}
			{anyVisible(isVisible, ["conectores.marketplace", "conectores.mcp", "conectores.guia"]) ? (
				<SettingsGroup title="Conectores">
					{isVisible("conectores.marketplace") ? (
						<OpenRow
							action="Abrir"
							icon={StoreIcon}
							description="Conectores nativos, MCP e APIs: GitHub, Slack, Google e outros."
							label="Marketplace de conectores"
							onOpen={() => onShortcut("conectores")}
						/>
					) : null}
					{isVisible("conectores.mcp") ? (
						<OpenRow
							action="Adicionar"
							icon={PlugIcon}
							description="Conecte um servidor MCP seu, por URL."
							label="MCP personalizado"
							onOpen={() => onShortcut("mcp")}
						/>
					) : null}
					{isVisible("conectores.guia") ? (
						<OpenRow
							action="Abrir"
							icon={StoreIcon}
							description="Abra um conector conectado para ver, editar ou gerar de novo o guia de uso do bot."
							label="Guia de uso do conector"
							onOpen={() => onShortcut("conectores")}
						/>
					) : null}
				</SettingsGroup>
			) : null}
			{anyVisible(isVisible, ["composio.chave", "composio.apps"]) ? (
				<SettingsGroup title="Composio">
					<ComposioSettings hideApps />
					{isVisible("composio.apps") ? (
						<OpenRow
							action="Abrir"
							icon={StoreIcon}
							description="Busque e conecte apps do Composio na aba Apps do Marketplace."
							label="Apps do Composio"
							onOpen={() => onShortcut("apps")}
						/>
					) : null}
				</SettingsGroup>
			) : null}
		</SettingsStack>
	);
}

/** Cofre: segredos e logins de sites do usuário (criptografados; o bot só vê nomes). */
export function CofrePane({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	return <VaultSettings isVisible={isVisible} />;
}

/** Habilidades: os procedimentos que o agente segue (lista, edição, importar e exportar). */
export function HabilidadesPane({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	return (
		<SettingsStack>
			{isVisible("habilidades.lista") ? (
				<section className="flex flex-col gap-2" data-slot="settings-skills">
					<h3 className="px-2 text-xs leading-4 text-muted-foreground">Habilidades</h3>
					<SkillsSettings />
				</section>
			) : null}
		</SettingsStack>
	);
}

/** Uso e custos. */
export function UsoPane() {
	return <UsageSettings />;
}

/** Linha de leitura: de onde vem a chave do OpenRouter. */
function OpenRouterKeyRow({ account }: { account: Account }) {
	const known = account.view !== null;
	const configured = account.view?.capabilities.openrouterKey ?? true;
	return (
		<SettingRow
			control="inline"
			description="A chave do OpenRouter fica no servidor; ela dá acesso aos modelos gratuitos e pagos."
			icon={KeyRoundIcon}
			label="Chave do OpenRouter"
		>
			<span className="text-[13px] text-muted-foreground">
				{!known ? "Carregando…" : configured ? "Configurada no servidor" : "Não configurada"}
			</span>
		</SettingRow>
	);
}

/** Desconectar o ChatGPT (dono): confirma antes de apagar os tokens. */
function DisconnectChatgptRow({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const enabled = account.view?.effective.providers.chatgptEnabled ?? null;
	const isOwner = account.view ? account.view.capabilities.isOwner : null;
	const provider = useChatgptProvider(undefined, false, enabled?.value === true && isOwner === true);
	const connection = useChatgptConnection();
	const [confirm, setConfirm] = useState(false);
	const error = connection.error ?? provider.error;
	const state = providersViewState({ enabled, isOwner, status: provider.status, error });
	if (!isVisible("provedores.desconectar") || !canDisconnect(state, enabled?.source)) return null;
	return (
		<>
			<SettingRow
				caption={error ? <p className="text-destructive">{error}</p> : null}
				control="inline"
				description="Remove a conexão e apaga os tokens salvos. Para só pausar o uso, desligue o plano acima, em Plano ChatGPT."
				icon={UnplugIcon}
				label="Conta ChatGPT conectada"
			>
				<Button
					disabled={connection.busy}
					onClick={() => setConfirm(true)}
					size="sm"
					variant="destructive"
				>
					Desconectar
				</Button>
			</SettingRow>
			<DisconnectChatgptDialog
				busy={connection.busy}
				onConfirm={() => {
					setConfirm(false);
					void connection.disconnect();
				}}
				onOpenChange={setConfirm}
				open={confirm}
			/>
		</>
	);
}

/** Execução e limites: ritmo do agente e tetos por execução. */
export function ExecucaoPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	const pace = ["execucao.disciplina", "execucao.paciencia"];
	const limits = ["execucao.passos", "execucao.tempo", "execucao.custo"];
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			{anyVisible(isVisible, pace) ? (
				<ExecutionSettings
					account={quiet}
					isVisible={(id) => pace.includes(id) && isVisible(id)}
					showStatus={false}
					title="Ritmo do agente"
				/>
			) : null}
			{anyVisible(isVisible, limits) ? (
				<ExecutionSettings
					account={quiet}
					isVisible={(id) => limits.includes(id) && isVisible(id)}
					showStatus={false}
					title="Limites por execução"
				/>
			) : null}
		</SettingsStack>
	);
}

/** Revisão automática (JEV): as duas revisões principais e, recolhido, o ajuste por recurso. */
export function RevisaoPane({ account, isVisible }: { account: Account; isVisible: (itemId: string) => boolean }) {
	const quiet = quietAccount(account);
	const jev = ["jev.modelo", "jev.mcp", "jev.geral", "jev.intencao", "jev.tools", "jev.verificacao", "jev.bloqueio", "jev.delegacao", "jev.travamento"];
	return (
		<SettingsStack>
			<PaneStatus account={account} />
			{anyVisible(isVisible, jev) ? <JevSettings account={quiet} isVisible={isVisible} showStatus={false} /> : null}
		</SettingsStack>
	);
}

/** Diagnóstico: estado do servidor, só leitura. */
export function DiagnosticoPane({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	return (
		<SettingsStack>
			<DiagnosticsSettings isVisible={isVisible} />
		</SettingsStack>
	);
}

/** O conteúdo de uma seção, já filtrado pela busca. */
export function SectionContent({
	section,
	account,
	isVisible,
	onShortcut,
}: {
	section: SettingsSectionId;
	account: Account;
	isVisible: (itemId: string) => boolean;
	onShortcut: (id: SettingsShortcutId) => void;
}): ReactNode {
	switch (section) {
		case "conta":
			return <ContaPane isVisible={isVisible} />;
		case "modelos":
			return <ModelosPane account={account} isVisible={isVisible} />;
		case "execucao":
			return <ExecucaoPane account={account} isVisible={isVisible} />;
		case "provedores":
			return <ProvedoresPane account={account} isVisible={isVisible} />;
		case "bots":
			return <BotsPane account={account} isVisible={isVisible} />;
		case "notificacoes":
			return <NotificacoesPane isVisible={isVisible} />;
		case "geral":
			return <GeralPane account={account} isVisible={isVisible} />;
		case "computador":
			return <ComputadorPane account={account} isVisible={isVisible} />;
		case "conexoes":
			return <ConexoesPane isVisible={isVisible} onShortcut={onShortcut} />;
		case "cofre":
			return <CofrePane isVisible={isVisible} />;
		case "habilidades":
			return <HabilidadesPane isVisible={isVisible} />;
		case "uso":
			return <UsoPane />;
		case "revisao":
			return <RevisaoPane account={account} isVisible={isVisible} />;
		case "diagnostico":
			return <DiagnosticoPane isVisible={isVisible} />;
	}
}
