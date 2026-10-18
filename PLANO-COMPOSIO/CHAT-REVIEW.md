# Correção de descoberta e login pelo chat

Base 18d87d1; branch fix/composio-agent-connect. Usuário reportou Composio ignorado, card de login ausente e logos não exibidas. Activation fica com subagente runtime; Marketplace/logos com subagente web. Root liga pedido explícito de conexão Composio ao card/login existente: campos opcionais em computer.ts/skill-card.ts/runs.ts, parser/persistência conversations/checkpoint, tool nova em tools/composio-login.ts e registro mínimo em computer-use.ts, transporte web/data/use-atlas-chat e componente novo de card. Preservar OAuth API, escopo do dono, cofre, pause/resume e VM/captcha. Nenhuma credencial ao modelo. O card abre login somente após clique; confirmação de conexão precede retomada. Composio na descoberta de apps não conectados era fora da v1 antiga, mas o usuário pediu este fluxo agora; mudança mínima com teste real de pausa e retomada do run. Sem merge/push/migration.

## Complemento (revisão e continuação)

- `detectLoginWall` passou a reconhecer a página real do Linear (só botões de provedor, sem textbox): 2+ entradas "Continue with ..."/"Log in with passkey", ou "Log in to <app>" numa página enxuta.
- `request_composio_login` virou `propose_connector` (módulo próprio): conector nativo do Marketplace (conectar ou reconectar), depois app do Composio com logo, nome e descrição, e por fim login pelo navegador. Card com `LoginConnector` (ícone, nome, descrição) persistido no histórico e no checkpoint.
- 401 do MCP em conector nativo emite o card de reconexão e pausa; `mcp_tool_search` sem resultado devolve "No connector for <app>; call propose_connector."
- "Abrir a VM" do card de login abre o diálogo da VM na mesma página (`SandboxViewerDialog`), com "Terminei" na própria tela; sem `window.open`.
- Não validado em navegador nem com OAuth/Composio reais (só testes com mocks e renders estáticos).
