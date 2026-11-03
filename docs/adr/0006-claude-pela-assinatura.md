# ADR 0006: Claude pela assinatura do próprio dono, com o Claude Code oficial

- **Status:** aceito (decisão do dono, 03/11/2026). Só a base está implementada (receita de instalação e nome do volume); o restante segue o plano em PRs pequenos.
- **Data:** 2026-11-03

## Contexto

O `PLANO-PROVEDORES.md` dizia: "Assinatura da Anthropic (Claude Pro/Max): uso PROIBIDO pelos termos deles. Não implementar... não deixar gancho". Isso valia para o que a regra imaginava na época: tirar o token da assinatura e usá-lo fora do produto oficial. O pedido agora é outro: o dono já tem uma assinatura e quer que o bot use o **Claude Code oficial**, logado por ele mesmo, para programar.

Releitura dos termos (https://code.claude.com/docs/en/legal-and-compliance.md, 03/11/2026):

- Instalar e rodar o Claude Code em produto de terceiros é permitido com condições: *"The Claude Code binary must not be modified. Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it"*.
- *"Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials..."*.
- Proibido: *"developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow"* e *"route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users"*.
- Permitido expressamente: *"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under 'Can customers offer Claude Code in their products?' above."*
- Os limites dos planos *"assume ordinary, individual usage of Claude Code and the Agent SDK"*.
- **Condição a confirmar pelo dono:** *"preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes...) requires agreeing to our Commercial Terms of Service"*.

## Decisão

1. A regra do `PLANO-PROVEDORES.md` muda: fica **permitido** o Claude Code oficial rodando na infraestrutura do Atlas, **entrado pelo próprio dono** com a conta dele. Continuam proibidos: coletar, guardar, ler, copiar ou repassar token ou credencial da assinatura; modificar o binário; usar o token fora do binário (SDK, proxy, outro cliente HTTP); usar assinatura de um usuário para outro; revender ou pagar o uso de terceiros.
2. **Binário oficial sem modificação**, em versão fixa e com SHA-256 conferido no build (`docker/agent-sandbox/Dockerfile`, `CLAUDE_CODE_VERSION`/`CLAUDE_CODE_SHA256`, do `manifest.json` oficial da versão), em `/usr/local/bin/claude` de root, sem autoatualização.
3. **Opção C: volume persistente por bot só com o login.** Nome `atlas-claude-<sha256(["claude-login", userId, botId])>` (`claudeLoginVolumeName` em `packages/sandbox/src/claude-login-volume.ts`), montado em `/home/atlas/.claude`. Escopo por dono e por bot; outro usuário nunca cai no mesmo volume (e o recurso de outro dono responde 404 nas rotas, como no resto do Atlas).
   - O **login é feito uma vez na VM do bot**, na tela do Computador (`claude auth login`, fluxo da Anthropic no navegador da VM), gravando nesse volume.
   - Ao programar, o **dev-sandbox monta o mesmo volume** e roda o Claude Code oficial lá dentro, com as ferramentas de dev e o isolamento de sempre. A VM não executa o código de repositório de terceiros.
   - **O Atlas nunca lê o conteúdo do volume**: só o cria, monta e apaga com o bot. O status vem do próprio binário (`claude auth status`), nunca de arquivo. Há teste que falha se qualquer código-fonte citar os arquivos de credencial ou o volume fora do módulo que o nomeia.
   - **Rede do dev-sandbox:** libera só os hosts da Anthropic de que o Claude Code precisa, na allowlist de egress existente (lista exata a confirmar no spike).
   - **Um processo Claude Code por bot por vez** (trava), sem rotina nem polling automático gastando a assinatura (uso individual comum).
4. Opt-in por bot, desligado por padrão; só o dono da conta liga. Bot compartilhado ou de grupo não herda a assinatura. Flag global `ATLAS_CLAUDE_SUBSCRIPTION` para desligar tudo.

## Alternativas descartadas

- **A. Rodar o Claude Code na VM do bot.** Mais simples (o login já vive no home), mas mistura a credencial com o ambiente que roda código de repositório de terceiros e perde o isolamento, o egress controlado e os limites do dev-sandbox.
- **B. Fazer o login dentro do dev-sandbox.** O dev-sandbox é efêmero, sem tela gráfica nem home persistente: não dá para entrar pelo fluxo da Anthropic e o login se perderia a cada sessão.
- **Copiar credenciais** (do volume ou da VM para o worker, o Agent SDK ou o dev-sandbox). Faz o Atlas trafegar e guardar o token, exatamente o que os termos proíbem. Também fica de fora usar o SDK com o token fora do binário oficial.

## Consequências

- Custo para o Atlas: zero em tokens. Disco: ~330 MB do binário por imagem e o volume de login (pequeno) por bot. Memória do Claude Code no dev-sandbox, sob os limites dele.
- **Riscos:** (1) **mudança de termos ou do CLI** pela Anthropic: versão fixada, flag global e releitura dos termos a cada atualização da versão; (2) **limite de uso individual** compartilhado com o uso manual do dono e que não cobre uso intenso: um processo por bot, sem automação, e aviso honesto quando o limite chegar; (3) **Commercial Terms**: hospedar o Claude Code pede aceitar os termos comerciais da Anthropic, o dono precisa confirmar antes do lançamento; (4) volume apagado = o dono entra de novo; (5) `~/.claude.json` (fora de `~/.claude`) pode guardar estado da conta: a verificar no spike, a saída provável é `CLAUDE_CONFIG_DIR=/home/atlas/.claude` para tudo ficar no volume; (6) migração de bots existentes: o bind novo cobre `~/.claude` do home atual, que passa a ser sombreado pelo volume (documentar no PR do bind).

## Versão fixada nesta base

- Claude Code `2.1.317`, `linux-x64`, SHA-256 `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0`. Conferido de duas formas em 03/11/2026: o `checksum` do `manifest.json` oficial dessa versão e o hash do binário baixado.

## Próximo passo

O bind do volume de login na criação da VM (`sandboxBinds`, que hoje recebe `conversationId`) e no dev-sandbox (`packages/sandbox/src/dev/docker-provider.ts`), com a rede só da Anthropic, entra no PR seguinte do plano (`claudeLoginBind` já existe e está testado). Ver o plano de "Claude pela assinatura", item 2 em diante.
