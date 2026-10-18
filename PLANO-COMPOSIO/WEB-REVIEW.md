# Composio — correção web

Posse autorizada: UI Marketplace, seção Composio e use-composio. Base 18d87d1, branch fix/composio-agent-connect. Não tocar API/runtime (outros agentes).

Correção: renderizar logos já recebidos da API; lista pesquisável dos apps no Marketplace com popup existente; hook inativo não consulta apps; erros e carregamento explícitos. Testes SSR/pure sem rede.

## Verificação

- Red: após gerar shared/dist local, teste settings logo recebeu HTTPS e falhou por ausência de img; 11 passaram, 1 falhou (1951.8617 ms). A primeira execução não chegou ao teste por shared/dist ausente.
- Green: settings Composio + todos testes Marketplace: 19 passaram, 0 falharam, 1176.6925 ms.
- pnpm --filter web typecheck: exit 0 (tsc --NoEmit).
- git diff --check: limpo. Sem rede real.

Marketplace consulta catálogo dinâmico com a busca comum e debounce de 300 ms, usando popup existente. Sem chave mostra Configurar; erro não vira lista vazia silenciosa; nativo já conectado informa precedência e oferece Configurar, sem conectar duplicata. Hook fecha a janela de consultas ao desabilitar. Logos HTTPS sem userinfo, referrerPolicy no-referrer e fallback de ícone ao erro de carga; teste cobre URL inválida/nula.

Limites: resultado paginado inicial da API, busca remota permite localizar outros apps. Logo de app conectado na seção de configurações usa catálogo carregado; se não veio na página, cai no ícone seguro. Sem validação visual no navegador ou OAuth real nesta entrega.
