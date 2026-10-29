# Changelog

Todas as mudanças relevantes do Atlas. Formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Cada entrega atualiza este arquivo (ver `.agents/rules/80-fluxo-de-trabalho.md`). `scripts/changelog.mjs` agrupa os commits por tipo e ajuda a montar a entrada.

## [Não lançado]

### Adicionado
- **web:** a lista de tarefas do bot fica presa em cima da caixa de digitar enquanto ele trabalha (uma linha "2/5 · tarefa atual" que abre a lista, acima da barra de aprovação); ao terminar, a conversa guarda só "Tarefas · 5/5 concluídas". A lista e a barra de aprovação ficam dentro do mesmo container da caixa de digitar (um bloco só, divisores finos)
- **sandbox, agent:** código mais confiável: `edit_file` tolera espaço no fim, recuo e CRLF (recusa trecho ambíguo), mostra "trechos parecidos" quando não acha e devolve a região editada; checagem de sintaxe de `.json`/`.js` depois de gravar; o terminal lembra a pasta e as variáveis entre comandos (sem gravar segredo); as ferramentas de código carregam para pedidos comuns (7/30 → 30/30); falha de edição não bloqueia mais a ferramenta; o limite brando não encerra run com edição sem testar; e o bot roda o teste antes de dizer "pronto" (uma vez por run). A imagem `dev-sandbox` é reconstruída pelo workflow de imagens (ver `docs/features/codigo-confiavel.md`)
- **worker, db, shared, agent:** "Seu dia" ligado por padrão: o bot principal liga sozinho o brief da manhã (todo dia, 30 min antes da sua primeira mensagem típica, entre 06:00 e 09:00, 07:30 sem histórico), sem chamar o modelo, uma checagem por bot por dia e só se houver fonte conectada ou algo pendente. O primeiro brief traz uma linha avisando; pausar, apagar ou pedir para parar grava a recusa e o bot nunca mais liga sozinho. Ao criar, o bot cita só as fontes que realmente lê, e a legenda do cartão não repete mais "Seu dia".
- **agent, api, db, web, llm, shared:** aprovou uma, vale para a tarefa: depois de aprovar uma escrita reversível num conector, a mesma ação no mesmo conector e conversa passa sem cartão por 30 min (até 30 usos), com contador no "Aprovado". Nunca para o que não dá para desfazer, segredo, destinatário/convidado externo, rotinas ou quando você marcou "sempre perguntar". Depois de o bot ler algo que você não escreveu (PDF, site, e-mail), a aprovação continua valendo, mas o Jev confere cada uso e, se achar ordem vinda de fora ou estiver indisponível, volta o cartão; sem nada de fora lido o Jev nem é chamado. O que o bot leu de fora vale para a conversa inteira (24 h ou até compactar), todo resultado de conector conta como "de fora" e e-mail ou link em qualquer argumento conta como destino externo. Tabela nova `mcp_task_grants` (migration aditiva; aplicar antes do deploy). O Jev vê o que você já aprovou, não pergunta só por dúvida de intenção em ação reversível e, fora do ar, deixa passar escrita reversível liberada pela sua autonomia (limites numéricos mantidos). O cartão do Jev ganhou "Sempre para <conector> · <ação>" (revogável em Autonomia). O bot diz a contagem em lotes e não afirma mais que "só a primeira rodou" (ver `docs/features/autonomia-aprovacoes.md`)
- **agent, worker, shared, db:** "Seu dia", o brief da manhã: peça "me prepara o dia às 7h30" e o bot lê as fontes que você conectou, de qualquer categoria, e manda uma mensagem curta no chat (compromissos, quem precisa de você, próximos passos) mais um push, sem painel. Serve para trabalho, estudos e vida pessoal. Com o chat ocupado, a mensagem entra assim que a tarefa termina (estado em colunas de `routine_runs`, mensagem idempotente; falha do run avisa em uma linha). Só leitura (trava em código), nunca pulado por chat em andamento, uma por bot. Modelo de rotina `daily_brief`, colunas `routines.template` e `routine_runs.briefStatus/briefText`, eval do e-mail malicioso (ver `docs/features/seu-dia.md`)
- **sandbox, web, agent:** VM estável: desligamento limpo do Chrome (o login de sessão não se perde), sem parada por inatividade, guarda de memória que desliga a VM parada há mais tempo (com aviso por push), botão "Desligar computador" e a tool `sandbox_release`, o login do navegador fica salvo e não se perde ao desligar, Cofre primeiro no muro de login, "Terminei" que confere a tela, aviso de login por conversa e trava contra afirmar a tela sem conferir (ver `docs/features/vm-estavel.md`)
- **agent:** o bot sabe a hora local (camada efêmera, sem invalidar o cache) e `propose_routine` aceita `in_minutes` para lembretes relativos calculados pelo servidor (#108)
- **agent:** corrige nome de ferramenta e argumentos malformados (#103)
- **agent:** perfil do bot injetável no `runComputerUse` (#103)
- **evals:** pacote de avaliação com cenários, runner com modelo real (diagnóstico modelo x harness) e cenário a partir de um run de produção (#103)
- **worker:** retenção diária de `run_events` e execuções de rotina (#104)

### Alterado
- **ui, web:** todos os cards do chat com a mesma pele: novo `ChatCard` (cartão e linha de atividade; `RequestCard` passa a usá-lo) sem borda, `bg-muted/60`, `rounded-2xl` e largura de 68 caracteres; anexo, ferramenta, skill, rotina criada, e-mail, painel, gráfico, código e lista de tarefas migrados; recolher/expandir com `Collapsible` ("Ver detalhes", "Mostrar menos", "Ver tudo (n)"); compactação usa o `Marker`. Vocabulário único (Agora não, Dispensado, Precisa de você), botão secundário `secondary`/`sm`, textos sem jargão (skill sem chave e versão, "Chaves e senhas", "Site da API / Acesso / O que faz", aviso do e-mail em palavras simples). Só apresentação e texto
- **ui, web:** base visual comum: tokens `text-body`/`text-caption`, `rounded-card`/`rounded-panel`, cores de estado `success`/`warning`/`info` (claro e escuro) e escala `z-sticky/overlay/modal/toast`; `Alert` e `Badge` ganham as variantes de estado e o `RequestCard` usa os mesmos tons; novo `Spinner` único (gira só com "reduzir movimento" desligado). Sem mudança de tamanho; os tons de estado ficam num só. Guarda automática `visual-base-guard` impede novos `text-[Npx]`, `rounded-[Npx]` e hex soltos (ver `.agents/rules/35-componentes.md`)
- **sandbox, api:** a VM não é mais parada por inatividade (`SANDBOX_IDLE_STOP=1` volta ao modo antigo); novas variáveis `SANDBOX_MAX_RUNNING` (3) e `SANDBOX_MIN_FREE_MEM_MB` (512); o stop espera 15 s e o poll do painel não religa VM desligada
- **infra:** deploy por imagem pronta: o GitHub Actions monta as imagens depois do CI e publica no GHCR; o Dokploy só baixa, com limite de memória por serviço (#106)
- **agent:** ferramentas carregadas ficam fixas na conversa, melhorando o cache (#103)
- **agent, worker, api, db, web, auth:** pacote de desempenho: início do run sem esperas em série, buscas nativas em paralelo, `/v1/events` por LISTEN/NOTIFY, respostas comprimidas, sessão em cookie por 5 min, listas sem colunas JSON grandes, chat sem re-render por token (#104)

### Corrigido
- **web:** a compactação aparece só como marcador, e o rascunho revisado não aparece mais na conversa (#108)
- **worker, agent:** um soluço do banco não derruba o run (retoma do checkpoint), e uma gravação de evento que falha não trava as seguintes (#108)
- **db:** um run que derruba o worker é interrompido depois de 3 recuperações sem progresso (#108)
- **worker:** o "Parar" fecha o run na hora mesmo quando o cancelamento chega como lease perdido (#108)
- **agent:** erro de argumento ou link morto não bloqueia a ferramenta pelo resto do run; o bloqueio expira em 3 passos (#108)
- **agent:** subagente que não consultou nenhuma fonte volta como parcial, não como pesquisa feita (#108)
- **mcp:** erro de negócio com número (ex.: "máximo 500") não vira mais "escrita incerta"; 5xx real continua incerto (#108)
- **agent:** triagem de mensagem no meio do run com teto de saída suficiente e motivo da falha no log (#108)
- **web:** a conversa não puxa mais para baixo quando o usuário subiu para ler enquanto o bot escreve (#107)
- **agent:** entende abreviação e "deixa sem" como remover, a regra de rejeição informal (#104)
- **web:** favicon com PNG RGBA (build com Turbopack falhava) (#104)
- **ui:** realce de código sem `setState` durante o render (#104)

### Documentação
- **evals:** como rodar e ler os resultados (#103)
- **plano:** regra de fluxo de trabalho (`80-fluxo-de-trabalho.md`) e modelo em `docs/features/`
