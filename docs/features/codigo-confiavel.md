# Código confiável na sessão de código

- **Status:** entregue
- **Data:** 2026-10-29
- **Issues/PRs:** PR A (confiança); velocidade e ponto de restauração vêm em PRs próprios

## O que é
O bot erra menos ao programar: a edição tolera diferenças pequenas de espaço, o terminal lembra a pasta, a ferramenta de editar não fica bloqueada depois de falhas, o run não para no meio e o bot roda o teste antes de dizer "pronto".

## Problema
O dono não confiava em passar uma tarefa de código. A comparação com o Hermes Agent mostrou as causas:
- `edit_file` exigia o texto idêntico; um espaço no fim da linha, recuo diferente ou CRLF falhava, e a resposta não ajudava a corrigir;
- 3 falhas seguidas bloqueavam `edit_file` pelo resto do run;
- cada `shell` era um `bash -lc` novo: `cd` e `export` se perdiam;
- o grupo `dev` só carregava com poucas palavras ("repo", "bug", "PR"): 7 de 30 pedidos comuns de código ativavam;
- no passo 24 o `softEvaluate` podia concluir um run com edição sem testar;
- nada pedia teste ou typecheck antes da resposta final.

## Por que existe
As ideias vêm do Hermes (`tools/fuzzy_match.py`, `file_operations_lint.py`, `terminal_tool.py`, `verification_stop.py`), adaptadas ao sandbox do Atlas e às regras do projeto (no máximo uma revisão de resposta por run, nada de internals para o usuário).

## Alternativas descartadas
- Casamento por similaridade (≥ 80%) como o `context_aware` do Hermes: risco de aplicar no lugar errado; ficamos com camadas determinísticas (CRLF, espaço no fim, indentação) e "trechos parecidos" só como dica.
- Shell persistente com um processo `bash` vivo por sessão: frágil com jobs em segundo plano e reinício do container; salvar cwd e variáveis em arquivo é simples e sobrevive a reinícios.
- Portão de verificação que repete até 3 vezes (Hermes, desligado por padrão por ser ruidoso): aqui é uma vez por run e conta no teto único de revisões.

## Como funciona
- **Edição** (`docker/dev-sandbox/server/edit-match.mjs`, `files.mjs`): exato → CRLF/LF → espaço no fim → indentação flexível (reindenta o `new`). Mais de uma ocorrência é recusada com as linhas; `replaceAll` só em casamento exato; edição já aplicada é reconhecida. Sem casamento, o erro traz até 3 "Trechos parecidos" com número de linha. O resultado de `edit_file`/`write_file` traz a região editada (±3 linhas, até 40).
- **Sintaxe** (`syntax-check.mjs`): `.json` e `.js/.mjs/.cjs` depois de gravar; só erro novo, nunca bloqueia. TS segue com `dev-diagnostics.ts`.
- **Shell** (`exec-jobs.mjs`): estado em `/workspace/.agent/shell-state/{cwd,env}` (fora do git). Só grava o que o comando mudou; segredos injetados e nomes com TOKEN/SECRET/PASSWORD/API_KEY… nunca vão para o arquivo. Cwd inexistente ou fora do workspace volta para a raiz. O resultado mostra o cwd final.
- **Intenção** (`context/intent-router.ts`, `DEV_PARTS`): extensões de arquivo de código, stack traces, "corrige/conserta + bug/função/build", "cria/edita + função/endpoint…", git e dependências; "código de barras/pix/cep" e "corrige o texto" não ativam.
- **Travas** (`tool-failure.ts`): `edit_file`, `write_file` e `read_file` não são bloqueadas por falhas seguidas; a partir da 3ª falha no mesmo arquivo o erro manda reler, usar âncora maior ou reescrever. Falha de edição não conta na trava global.
- **Verificação** (`execution/dev-verification.ts`): o run sabe se houve edição depois do último teste/typecheck/lint/build que passou. Com edição pendente, o limite brando estende em vez de concluir (teto duro e relógio continuam). Na resposta final com edição sem verificar, uma vez por run, o bot é mandado de volta para testar; se terminar sem testar, a resposta é aceita. Não vale para subagente, webhook ou run sem sessão de código.

## Riscos
- A edição tolerante, a checagem de sintaxe e o shell persistente moram na imagem `dev-sandbox`. O workflow `Imagens` a reconstrói sozinho porque `docker/dev-sandbox/**` mudou; sessões de código já abertas seguem na imagem antiga até o container ser recriado. Com a imagem antiga o runtime continua funcionando como antes (os campos novos são opcionais).
- Casamento por indentação pode reindentar diferente do esperado em blocos com recuo misto: coberto por teste e avisado no resultado ("indentação ajustada").
- O estado da verificação não vai para o checkpoint: um run retomado não cobra verificação (lado seguro).
- O portão de verificação usa a única revisão do run: se ele disparar, outro portão posterior não revisa.

## Custo
- Sem chamada extra de modelo; no máximo um passo a mais por run de código (o pedido de verificação).
- Pedidos de código que carregam as ferramentas no passo 1: 7/30 → 30/30, falsos positivos 1/18 → 0/18 (tabela em `intent-router.dev.test.ts`).

## Como testar
- `cd docker/dev-sandbox && node --test "test/*.test.mjs"`
- `pnpm --filter @workspace/agent-runtime test` (inclui `computer-use.code-loop.test.ts`, `intent-router.dev.test.ts`, `dev-verification.test.ts`, `tool-failure.test.ts`)
