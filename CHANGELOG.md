# Changelog

Todas as mudanças relevantes do Atlas. Formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Cada entrega atualiza este arquivo (ver `.agents/rules/80-fluxo-de-trabalho.md`). `scripts/changelog.mjs` agrupa os commits por tipo e ajuda a montar a entrada.

## [Não lançado]

### Adicionado
- **agent:** corrige nome de ferramenta e argumentos malformados (#103)
- **agent:** perfil do bot injetável no `runComputerUse` (#103)
- **evals:** pacote de avaliação com cenários, runner com modelo real (diagnóstico modelo x harness) e cenário a partir de um run de produção (#103)
- **worker:** retenção diária de `run_events` e execuções de rotina (#104)

### Alterado
- **agent:** ferramentas carregadas ficam fixas na conversa, melhorando o cache (#103)
- **agent, worker, api, db, web, auth:** pacote de desempenho: início do run sem esperas em série, buscas nativas em paralelo, `/v1/events` por LISTEN/NOTIFY, respostas comprimidas, sessão em cookie por 5 min, listas sem colunas JSON grandes, chat sem re-render por token (#104)

### Corrigido
- **agent:** entende abreviação e "deixa sem" como remover, a regra de rejeição informal (#104)
- **web:** favicon com PNG RGBA (build com Turbopack falhava) (#104)
- **ui:** realce de código sem `setState` durante o render (#104)

### Documentação
- **evals:** como rodar e ler os resultados (#103)
- **plano:** regra de fluxo de trabalho (`80-fluxo-de-trabalho.md`) e modelo em `docs/features/`
