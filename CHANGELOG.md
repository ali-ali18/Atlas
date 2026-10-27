# Changelog

Todas as mudanças relevantes do Atlas. Formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Cada entrega atualiza este arquivo (ver `.agents/rules/80-fluxo-de-trabalho.md`). `scripts/changelog.mjs` agrupa os commits por tipo e ajuda a montar a entrada.

## [Não lançado]

### Adicionado
- **agent, worker, shared, db:** "Seu dia", o brief da manhã: peça "me prepara o dia às 7h30" e o bot lê as fontes que você conectou, de qualquer categoria, e manda uma mensagem curta no chat (compromissos, quem precisa de você, próximos passos) mais um push, sem painel. Serve para trabalho, estudos e vida pessoal. Com o chat ocupado, a mensagem entra assim que a tarefa termina (estado em colunas de `routine_runs`, mensagem idempotente; falha do run avisa em uma linha). Só leitura (trava em código), nunca pulado por chat em andamento, uma por bot. Modelo de rotina `daily_brief`, colunas `routines.template` e `routine_runs.briefStatus/briefText`, eval do e-mail malicioso (ver `docs/features/seu-dia.md`)
- **sandbox, web, agent:** VM estável: desligamento limpo do Chrome (o login de sessão não se perde), sem parada por inatividade, guarda de memória que desliga a VM parada há mais tempo (com aviso por push), botão "Desligar computador" e a tool `sandbox_release`, perfil do navegador por bot (não por conversa), Cofre primeiro no muro de login, "Terminei" que confere a tela, aviso de login por conversa e trava contra afirmar a tela sem conferir (ver `docs/features/vm-estavel.md`)
- **agent:** o bot sabe a hora local (camada efêmera, sem invalidar o cache) e `propose_routine` aceita `in_minutes` para lembretes relativos calculados pelo servidor (#108)
- **agent:** corrige nome de ferramenta e argumentos malformados (#103)
- **agent:** perfil do bot injetável no `runComputerUse` (#103)
- **evals:** pacote de avaliação com cenários, runner com modelo real (diagnóstico modelo x harness) e cenário a partir de um run de produção (#103)
- **worker:** retenção diária de `run_events` e execuções de rotina (#104)

### Alterado
- **sandbox, api:** a VM não é mais parada por inatividade (`SANDBOX_IDLE_STOP=1` volta ao modo antigo); novas variáveis `SANDBOX_MAX_RUNNING` (3) e `SANDBOX_MIN_FREE_MEM_MB` (512); o stop espera 15 s e o poll do painel não religa VM desligada
- **sandbox:** o volume `atlas-profile-*` passa a ser por usuário+bot; volumes antigos (por conversa) não são migrados, então o login é refeito uma vez por bot
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
