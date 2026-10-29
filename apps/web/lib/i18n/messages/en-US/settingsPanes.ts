import type { settingsPanes as ptBR } from "../pt-BR/settingsPanes";
import type { NamespaceMessages } from "../../translator";

export const settingsPanes: NamespaceMessages<typeof ptBR> = {
	"settings.panes.planChatgpt": "ChatGPT plan",
	"settings.panes.keysAndAccounts": "Keys and accounts",
	"settings.panes.mainModels": "Main models",
	"settings.panes.modelsByDifficulty": "Models by difficulty",
	"settings.panes.auxModels": "Helper models",
	"settings.panes.contextAndReplies": "Context and replies",
	"settings.panes.botGroups": "Bot groups",
	"settings.panes.conversation": "Conversation",
	"settings.panes.browser": "Browser",
	"settings.panes.connectors": "Connectors",
	"settings.panes.composio": "Composio",
	"settings.panes.skills": "Skills",
	"settings.panes.pace": "Agent pace",
	"settings.panes.limits": "Limits per run",
	"settings.panes.open": "Open",
	"settings.panes.add": "Add",
	"settings.panes.marketplace": "Connector marketplace",
	"settings.panes.marketplaceHint": "Native connectors, MCP and APIs: GitHub, Slack, Google and more.",
	"settings.panes.customMcp": "Custom MCP",
	"settings.panes.customMcpHint": "Connect your own MCP server by URL.",
	"settings.panes.connectorGuide": "Connector usage guide",
	"settings.panes.connectorGuideHint": "Open a connected connector to view, edit or regenerate the bot's usage guide.",
	"settings.panes.composioApps": "Composio apps",
	"settings.panes.composioAppsHint": "Search and connect Composio apps in the Apps tab of the Marketplace.",
};
