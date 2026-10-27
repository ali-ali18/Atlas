# VM estável

- **Status:** entregue (aguardando merge)
- **Data:** 2026-10-27
- **Issues/PRs:** branch `fix/vm-estavel`

## O que é
O computador do bot (a VM) fica ligado enquanto você precisa, o login do navegador fica salvo e não se perde ao desligar, entra sozinho com o login salvo no Cofre e não diz que entrou quando a tela está em branco.

## Problema
Em produção a VM aparecia com o Chrome em `about:blank` e a bolha "Restore pages? Chrome didn't shut down correctly". O bot mostrava o card "Preciso que você faça login em <site>" mesmo com o login salvo no Cofre, e o Haiku afirmou "entrou, painel logado" com a tela em branco. Causas verificadas no código:

1. **Parada à força.** O `entrypoint.sh` era PID 1 sem `trap` e o container não tinha `Init`. O `docker stop` mandava SIGTERM a um shell que não repassava, e em 5 s vinha o SIGKILL. O Chrome nunca fechava direito (`exit_type=Crashed` no perfil), e o login de sessão (cookie sem validade) se perdia.
2. **Parada por inatividade.** O reaper parava a VM após 15 min sem uso (`SANDBOX_TTL_MS`), o que disparava o item 1 com frequência.
3. **Sem controle de parada.** Não havia tool do bot nem botão na UI para liberar a VM (só a rota `DELETE`, sem botão).
4. **Cofre só sob pedido.** O `login_fill` só roda se o modelo o chamar e se a página já for do domínio salvo; num navegador em branco recusa e o card aparecia.
5. **"Terminei" às cegas.** Retomava com `[login-complete]` sem olhar a tela, e o aviso "já pedi login" valia só dentro do run.
6. **Nada obrigava a conferir a tela** antes de afirmar o estado dela.

## Por que existe
Cada item ataca uma causa medida no código, em commits separados, cada um com teste. O objetivo é que "entrou uma vez" valha para o bot inteiro e que a VM só pare por decisão (usuário, bot ou falta de memória).

## Alternativas descartadas
- **Aumentar só o timeout do stop:** sem `Init` e sem `trap` o SIGTERM nem chega ao Chrome.
- **Manter o TTL de 15 min com um aviso:** a perda do login é o custo; a memória é tratada pelo guarda, que só age sob pressão.
- **Cofre sem aprovação:** o uso do login continua exigindo a primeira aprovação por conversa (ou "sempre para este bot").

## Como funciona
1. **Desligamento limpo** (`docker/agent-sandbox/entrypoint.sh`, `bin/atlas-chrome`, `packages/sandbox/src/docker-manager.ts`): container criado com `Init: true` (tini); `trap` de TERM/INT no entrypoint fecha o Chrome (`pkill -TERM -x chrome`, espera até 10 s) antes de sair; `SANDBOX_STOP_TIMEOUT_S = 15` em todo stop de sessão viva. O `atlas-chrome` passa `--hide-crash-restore-bubble` e `--restore-last-session` e, antes de abrir, grava em `Default/Preferences` `exit_type=Normal`, `exited_cleanly=true` e `session.restore_on_startup=1` ("continuar de onde parou"; tolerante a arquivo ausente ou inválido). O `restore_on_startup` é o que faz o Chrome guardar os cookies sem validade (login de sessão) ao fechar; o custo é reabrir as abas antigas na volta. Com sessão anterior no perfil o `about:blank` do chamador é descartado (não acumula aba em branco). O lançamento roda sob `flock` no volume do perfil (`.atlas-launch.lock`, herdado pelo Chrome): dois lançamentos simultâneos, ou duas VMs no mesmo perfil, não abrem dois Chromes. Os containers de perfil têm nome fixo (`profileContainerName`): se api e worker criam ao mesmo tempo, o Docker devolve 409 para o segundo, que adota a VM do primeiro.
2. **Sem parada por inatividade** (`packages/sandbox/src/reaper.ts`, `memory-guard.ts`, `apps/api/src/index.ts`): o reaper só para ociosas com `SANDBOX_IDLE_STOP=1`. O guarda de memória (`SANDBOX_MAX_RUNNING`, padrão 3; `SANDBOX_MIN_FREE_MEM_MB`, padrão 512; `0` desliga) escolhe a VM ociosa há mais tempo (só quem está sem ferramenta há 2+ min, via `/idle` do control server), avisa o dono por push (`run-finished`: "Desliguei a VM para liberar memória...") e para com graça. Funções puras: `pickVmsToStop`, `loadMemoryGuardLimits`.
3. **Controles de parada**: `POST /v1/sandbox/sessions/:id/stop` (escopo do dono, 404 para outro usuário), botão "Desligar computador" na aba Computador (`stop-computer-button.tsx`, via `lib/atlas-api.ts`) e a tool `sandbox_release` (`packages/agent-runtime/src/tools/sandbox-release.ts`, grupo `browser`). O poll do painel e a abertura da conversa usam `wake=0`: VM desligada não é religada sozinha; "Acordar" continua sendo a escolha.
4. **Login que sobrevive** (`profileVolumeName(conversationId, userId)`, sem mudança): o volume `atlas-profile-*` continua chaveado por `[userId, conversationId]`. Cada bot tem uma única conversa (`Bot.conversationId` é `@unique`), então já é um perfil por bot, e os volumes existentes continuam valendo no deploy. O login só se perde se você pedir "Limpar sessão do navegador".
5. **Cofre primeiro** (`tools/vault-login-offer.ts#tryAutoVaultLogin`): no muro de login, com login casando pelo domínio registrável (`domainMatches`) e uso já aprovado, o runtime preenche, confere a tela por snapshot e segue sem card. Sem aprovação, o card com a oferta do Cofre é o cartão de aprovação. O card "faça você mesmo" só aparece sem login salvo ou se a tela de login continuar (senha errada, 2FA, captcha).
6. **"Terminei" confere a tela** (`computer-use.ts`): se a tela de login continua, responde em português e não segue. O "já pedi login" vale por conversa por 30 min e por site (`listRecentLoginAskSites`, lido dos cards persistidos); o modelo recebe a nota em vez do card.
7. **Trava contra inventar a tela** (`tools/browser-claims.ts`): resposta final que afirma estado da tela, com ação depois da última leitura ou última página `about:blank`/login, volta ao modelo uma vez (nota "verify the current screen with browser_snapshot before claiming its state"; rascunho recolhido com o motivo `unverified_screen`). `login_fill` com envio devolve título e URL lidos depois de enviar.

## Riscos
- **Memória.** VMs ficam ligadas por mais tempo. Cobertura: testes puros do guarda (limite, LRU, VM em uso nunca é escolhida). Em servidor pequeno, ajuste `SANDBOX_MAX_RUNNING`.
- **Mais uma revisão em algumas respostas** (trava contra inventar): custa um passo a mais, no máximo uma vez por run.
- **Deploy com versões mistas.** Nenhuma migration nem mudança de volume. Imagem antiga da VM sem o `trap` continua funcionando (só sem o fechamento limpo) até ser reconstruída.
- **Teto de tools no 1º passo** de "Bom dia" subiu de 22 para 23 (`sandbox_release`, grupo `browser`); o prefixo segue abaixo de 40 mil caracteres.

## Custo
Sem custo extra de infra além da VM ligada por mais tempo (limitada pelo guarda). Tokens: uma revisão a mais só quando a resposta afirma a tela sem conferir; o Cofre primeiro evita o ciclo card + "Terminei" + novo run.

## Como testar
- `pnpm --filter @workspace/sandbox test` (Init, stop de 15 s, volume do perfil, guarda de memória, reaper sem idle stop, `wake:false`).
- `pnpm --filter @workspace/agent-runtime test` (`computer-use.sandbox-release`, `computer-use.vault-login`, `computer-use.screen-claims`, `tools/browser-claims`, economia de "Bom dia").
- db e api: `login-asks`, `routes/sandbox-ownership`.
- Shell: `bash -n docker/agent-sandbox/entrypoint.sh docker/agent-sandbox/bin/atlas-chrome`.

## Conferir à mão (não validado em container real)
O ambiente de desenvolvimento não tinha daemon Docker, então a sobrevivência do login de sessão não foi testada com Chrome de verdade. Depois do deploy, com a imagem nova: abra o navegador da VM, entre num site cujo login seja cookie de sessão (sem "lembrar de mim"), clique em "Desligar computador" (ou `docker stop <vm>`), religue (`docker start`) e confira que o site continua logado e que não apareceu "Restore pages?".

## Conferir no servidor depois do deploy
1. **`CONNECTOR_ENCRYPTION_KEY` válida** (32 bytes em base64). Se mudou na restauração, o Cofre fica inutilizável e o fluxo "Cofre primeiro" cai no card humano: os logins salvos precisam ser cadastrados de novo.
2. **Volumes `atlas-profile-*` existentes seguem valendo**: não há o que migrar nem remover.
3. **Imagem da VM reconstruída** (`docker/agent-sandbox`), para ter o `trap` e o `atlas-chrome` novos. VMs já criadas ganham `Init` só quando recriadas.
4. `SANDBOX_MAX_RUNNING` e `SANDBOX_MIN_FREE_MEM_MB` ajustados ao tamanho do servidor; `SANDBOX_IDLE_STOP` fora (ou `0`).
