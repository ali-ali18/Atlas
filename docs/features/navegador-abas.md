# Navegador: abas novas e browser_tabs

- **Status:** entregue
- **Data:** 2026-10-30
- **Issues/PRs:** correção reportada pelo dono (captura de tela de um LMS universitário)

## O que é
Quando um link abre em outra aba, o bot passa para ela sozinho e avisa; ele também consegue listar, trocar e fechar abas.

## Problema
Num LMS, o botão "Acessar" abre o conteúdo em aba nova. O control server guardava a primeira página e nunca seguia popups: o bot achava que o clique não funcionava ("o botão Acessar não responde ao clique"), repetia, tirava print da aba velha e entrava em laço.

## Por que existe
O modelo não vê abas. Seguir a aba nova no servidor corrige leitura, clique e print de uma vez (tudo usa `getPage()`), e o aviso no resultado da ferramenta explica o que aconteceu sem gastar uma chamada extra.

## Alternativas descartadas
- Só dizer ao modelo para "procurar a aba": custa passos e ainda falha em popup que se fecha sozinho.
- Ouvir `context.on("page")`: pega também abas abertas pela pessoa e pelo subagente; o evento `popup` da aba ativa é exato.
- Abrir o link na mesma aba (remover `target`): quebra sites que dependem do `opener` e do fluxo de pagamento/login.

## Como funciona
- `docker/agent-sandbox/control/browser-session.mjs`: a aba principal ouve `popup` e `close`. Popup da aba ativa vira a principal (vai para a frente) e gera aviso; popup de aba em segundo plano vira aba comum na lista. Aba ativa fechada: volta para quem a abriu, senão para a mais recente.
- Subagentes: a aba deles continua isolada. Nunca vira a principal; popups abertos por ela ficam fora da lista e do fallback e são fechados junto com a aba.
- O aviso sai no cabeçalho `x-atlas-tab-notice` (texto codificado) da primeira resposta depois do evento, só para a aba do pai (`attachTabNotice`). `/health` e `/idle` nunca o consomem.
- `POST /browser/tabs` `{action: list|switch|close, index}` (índice a partir de 1; fechar a última aba é recusado).
- `packages/sandbox`: `controlBrowserTabs`, guarda do aviso por VM (`takeTabNotice`).
- `packages/agent-runtime`: tool `browser_tabs` (`tools/computer-tabs.ts`, grupo `browser`), e `executeTool` anexa `[aviso]` ao resultado de qualquer ferramenta de VM. Subagentes de navegador não recebem a tool.

## Riscos
- Imagem antiga da VM com runtime novo: sem cabeçalho nem `/browser/tabs` (a tool devolve o erro 404 do servidor, o resto segue). Runtime antigo com imagem nova: ignora o cabeçalho.
- O aviso espera o título carregar (até ~4 s); se ainda não saiu, vem na próxima resposta (a troca de aba já valeu).
- Aba aberta pela pessoa no viewer (sem passar pela aba ativa) aparece só na lista; o bot não troca sozinho.
- Título de página é dado não confiável: limpo (uma linha, 100 caracteres) e a lista leva o aviso padrão de dado não confiável.

## Custo
Sem chamada extra de modelo. Tool nova: ~0,6 mil chars no prefixo do passo 1 (teto do teste de "Bom dia" de 40 para 41 mil).

## Como testar
- `docker/agent-sandbox/control`: `node --test browser-session.tabs.test.mjs` (falsos + Chromium real com `target=_blank` e `rel=noopener`; use `ATLAS_TEST_CHROMIUM` se o Chromium não for achado).
- `pnpm --filter @workspace/sandbox test`, `pnpm --filter @workspace/agent-runtime test` (`computer-tabs.test.ts`, replay em `computer-use.economy-replay.test.ts`).
