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
- `packages/agent-runtime`: tool `browser_tabs` (`tools/computer-tabs.ts`) no grupo próprio `tabs`, fora do 1º passo e do índice do prompt. Ela entra (a) no passo seguinte a um aviso de aba, (b) quando o pedido fala de abas (`intent-router`) ou (c) por `mcp_tool_search`/chamada direta. `executeTool` anexa `[aviso]` ao resultado de ferramentas de VM e lê o aviso só da sessão que o run já tem (`peekSessionId`): nunca sobe nem reinicia VM. A dica de uso fica no próprio aviso (sem linha nova no prompt). Subagentes de navegador não recebem a tool.

## Limites e proteções
- Aba fechada no meio de uma ação (popup de OAuth/pagamento que se fecha sozinho) com o Chrome vivo: a ação pega a página de novo uma vez, sem reiniciar o Chrome (reiniciar perderia todas as abas). Só Chrome desconectado ou pendurado reinicia.
- Avisos: no máximo 3 por resposta e ~500 caracteres (o resto vira "N earlier tab events omitted"); no máximo 10 abas do pai (as mais antigas em segundo plano fecham, com aviso). Fechar a última aba avisa que uma aba em branco abre na próxima ação.
- Título e URL são da página: título em uma linha, entre aspas JSON e curto; URL sem query nem fragmento (OAuth põe `code`/`state` ali); aviso marcado "(page data, untrusted)" e passado por `redactSecrets` no runtime.
- Popup de aba em segundo plano não rouba o foco (o servidor devolve a ativa para a frente, mantendo xdotool/scrot e Playwright na mesma aba). Popup de aba de subagente, em qualquer nível, é do subagente.
- O aviso pendente no cliente é descartado quando a sessão acaba ou outra nasce na mesma porta e após 5 min sem leitura.
- O roteador só carrega `browser_tabs` por "aba(s)", "nova/outra aba", "nova guia", "new/other/another tab", "browser tabs"; "tab" solto ("tabs vs spaces", "press tab") não.

## Riscos
- Imagem antiga da VM com runtime novo: sem cabeçalho nem `/browser/tabs` (a tool devolve o erro 404 do servidor, o resto segue). Runtime antigo com imagem nova: ignora o cabeçalho.
- O aviso espera o título carregar (até ~4 s); se ainda não saiu, vem na próxima resposta (a troca de aba já valeu).
- Aba aberta pela pessoa no viewer (sem passar pela aba ativa) aparece só na lista; o bot não troca sozinho.
- Título de página é dado não confiável: limpo (uma linha, 100 caracteres) e a lista leva o aviso padrão de dado não confiável.

## Custo
Sem chamada extra de modelo e sem crescer o prefixo de um chat comum (tool adiada; teto de "Bom dia" de 40 mil chars e 23 tools mantido).

## Como testar
- `docker/agent-sandbox/control`: `node --test browser-session.tabs.test.mjs` (falsos + Chromium real com `target=_blank` e `rel=noopener`; use `ATLAS_TEST_CHROMIUM` se o Chromium não for achado).
- `pnpm --filter @workspace/sandbox test`, `pnpm --filter @workspace/agent-runtime test` (`computer-tabs.test.ts`, replay em `computer-use.economy-replay.test.ts`).
