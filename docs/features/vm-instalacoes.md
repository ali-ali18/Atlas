# VM com instalações que ficam

- **Status:** entregue na branch `feat/vm-instalar` (aguardando auditoria independente, prévias não se aplicam: sem tela nova)
- **Data:** 2026-11-02
- **Issues/PRs:** branch `feat/vm-instalar`

## O que é
O computador do bot (a VM) passa a se comportar como uma máquina Linux própria: o bot instala programas de verdade (apt, `.deb`, AppImage, pip, nvm) e o que foi instalado continua lá depois que a VM é desligada e recriada.

## Problema
A VM roda os comandos do bot como `atlas`, sem sudo, e só dois volumes sobreviviam à recriação do container (perfil do Chrome e `/home/atlas/work`). Pedir "instala o VLC" ou "instala esse .deb" não funcionava, e tudo fora desses dois volumes se perdia quando o container era recriado (imagem nova, guarda de memória).

## Por que existe
Dar ao bot o que uma pessoa teria num Linux dela, sem abrir mão do isolamento:

1. **Argumentos estreitos, não root estreito.** O `atlas` ganha `sudo` para UMA coisa: `/usr/local/bin/atlas-install`. O instalador valida pacote, caminho e `.deb` antes de chamar o apt e impede abusos de argumento (`-o ...`, `;`, caminho fora do home). Isso NÃO contém o que o pacote faz: instalar um pacote é rodar código (`postinst`) como root DENTRO da VM do bot. A fronteira de segurança é o container, não o usuário `atlas`.
2. **Home persistente.** Novo volume `atlas-home-<hash>` em `/home/atlas` (mesma chave `[userId, conversationId]` dos outros dois). `nvm`, `pip --user`, `~/.local/bin`, AppImage (rodar com `--appimage-extract-and-run`: a VM não tem FUSE) e binários baixados ficam guardados sem nenhum código novo.
3. **Registro e reinstalação.** O que foi instalado como root (fora do home, em `/usr`) vai para `~/.atlas/installed.json`; quando a VM sobe de novo, o entrypoint reinstala em segundo plano o que faltar.

## Alternativas descartadas
- **`sudo` amplo (apt-get, dpkg ou shell):** o `apt-get` aceita opções como `-o APT::Update::Pre-Invoke=...`, que executam comando arbitrário como root. Liberar o apt-get com sudo é liberar root livre; por isso o sudoers cita só o `atlas-install`, que monta o `apt-get` com argumentos fixos.
- **`docker commit` por bot (guardar a imagem inteira do container):** cada bot teria uma imagem de GBs, sem reaproveitar camadas da imagem base, atualizações da imagem base nunca chegariam ao bot, e o commit tem de ser feito pela API com acesso ao Docker (superfície maior). Registro + reinstalação guarda KB por bot e deixa o bot na imagem nova.
- **Só o registro, sem volume de home:** perderia `nvm`, `pip --user`, AppImage, tudo que não vem do apt.
- **Montar o `/usr` ou o `/var/lib/dpkg` num volume:** a imagem nova nunca chegaria (arquivos antigos por cima) e o dpkg ficaria inconsistente com a imagem.
- **Rodar `apt` como o próprio `atlas` com capabilities:** não existe apt sem root; a alternativa seria um container com mais privilégios, o que o plano proíbe.

## Como funciona

### Pacote `atlas-install` (dentro da imagem, `docker/agent-sandbox/install/`)
- `atlas-install` (wrapper `sh`, root) → `atlas-install.mjs` (CLI) + `atlas-install-lib.mjs` (validação pura, testável sem root). Tudo de dono root e sem escrita para o `atlas`; sudoers em `/etc/sudoers.d/atlas-install` (0440, `visudo -c` no build): `atlas ALL=(root) NOPASSWD: /usr/local/bin/atlas-install`, com `env_reset`.
- `sudo atlas-install apt <pkg...>`: nomes por `^[a-z0-9][a-z0-9+.-]{0,62}$` (e sem `-` no fim), no máximo 10 por chamada. Cada nome também precisa existir exatamente no índice (`apt-cache pkgnames`), porque o apt trataria `a.+` como expressão regular e instalaria dezenas de pacotes. Roda `apt-get update` só se faltar índice ou o carimbo passar de 6 h, e `apt-get install -y --no-install-recommends --no-remove` com ambiente limpo (sem `APT_CONFIG`, `LD_PRELOAD` etc.). `--no-remove`: instalar nunca remove outro pacote (não derruba sudo, node ou o desktop).
- `sudo atlas-install deb <arquivo>`: o arquivo tem de estar em `/home/atlas` (`..` no texto é recusado; `realpath` precisa ficar dentro do home; abre com `O_NOFOLLOW` e confere de novo pelo `/proc/self/fd` onde o arquivo aberto está, então trocar um diretório por link simbólico no meio do caminho não vale). Copia para `~/.atlas/debs/<pacote>_<12 hex do sha256>.deb` (root, 0644), lê `Package` e `Architecture` com `dpkg-deb`, aceita só a arquitetura da VM ou `all`, e instala com `apt-get install -y /proc/<pid do instalador>/fd/<N>/<arquivo>` (o diretório `debs/` já verificado, aberto pelo instalador; resolve dependências). Não validado com o apt real: se o apt não aceitar esse caminho, trocar por `/home/atlas/.atlas/debs/<arquivo>` em `storedDebArg`. Teto de 512 MiB por arquivo e 2 GiB de `.deb` guardados.
- `sudo atlas-install list`: o registro com a data e se cada item está instalado agora, mais o estado da reinstalação. `sudo atlas-install remove <pkg>`: só pacote do registro; remove também o que o apt remover junto e tira todos do registro.
- Códigos de saída: `0` ok, `1` falha do apt/dpkg, `64` uso, `65` entrada recusada, `66` arquivo não encontrado, `69` indisponível, `75` outra instalação em andamento, `77` sem permissão. Mensagens em inglês, para o modelo ler (o bot traduz para o usuário sem citar o comando). `--dry-run` valida e mostra o plano sem tocar em nada (usado nos testes).
- Uma instalação por vez. Trava em `/run/atlas-install.lock`, criada de forma atômica (link de um temporário que já tem o pid) e liberada só se ainda for a nossa; dono morto é retomado só se o arquivo ainda tem o mesmo pid morto. O comando do agente espera até 30 s (depois sai com 75); o `reinstall` espera até 10 min por um comando do agente em curso, e o relógio de 15 min só começa depois de pegar a trava, então ele não vira `failed` só porque o agente estava instalando.
- **O último instalado vence.** O mesmo pacote nunca fica em apt e em deb ao mesmo tempo: `deb` tira a entrada apt do mesmo nome; `apt` tira a entrada deb e apaga o arquivo órfão. Um registro com os dois (adulterado) fica com o de data mais recente (empate: o `.deb`).
- `.atlas` e `debs/` recém-criados têm dono e modo ajustados pelo descritor (`fchown`/`fchmod` depois de abrir com `O_DIRECTORY|O_NOFOLLOW`), e só se o diretório for nosso e estiver vazio.

### Registro e confiança (`~/.atlas`)
O `atlas` é dono do próprio home e poderia pré-criar `.atlas` (ou um link para `/etc`) para enganar quem escreve como root. Por isso:
- `.atlas` é criado por root (0755). Se já existir de outro dono, com escrita para grupo/outros ou como link, é movido para `.atlas.untrusted-<data>` (e o registro recomeça vazio); nunca é seguido.
- As escritas de root vão por `/proc/self/fd/N`, apontando para o diretório já verificado: mesmo que o `atlas` renomeie `.atlas` depois, o root continua escrevendo no diretório confiável.
- Na leitura, cada entrada do `installed.json` passa de novo pelas mesmas regras da entrada do usuário (nome do pacote; `.deb` só com nome `<pacote>_<hash>.deb`, hash de 64 hex e coerente com o pacote). O que não passa é descartado e registrado em `install.log`. Antes de reinstalar um `.deb`, confere-se que ele está em `debs/`, é arquivo comum de root e tem o mesmo sha256 do registro.
- Arquivos do registro: `installed.json`, `debs/`, `install.log` (rotaciona em 1 MiB), `reinstall.status`. O `atlas` lê tudo e não escreve em nada.

### Reinstalação ao ligar (`entrypoint.sh`)
1. `atlas-install prepare` (síncrono, rápido, sem rede): deixa `.atlas` confiável e grava `reinstall.status` (`pending` se há algo a reinstalar, senão `done`; quem muda para `running` é o `reinstall`, quando começa de fato).
2. `atlas-install reinstall` em **segundo plano** (`nice`), depois do `prepare` e antes de o control server subir; a VM não espera por ele. Compara o registro com `dpkg-query`, faz `apt-get update` se preciso e instala o que falta (primeiro em lote; se o lote falhar, um a um, para um pacote ruim não travar os outros).
3. **Limite de 15 minutos** no total (`REINSTALL_BUDGET_MS`). Estouro ou falha: `failed`, com a lista do que voltou e do que não voltou. O agente lê `cat ~/.atlas/reinstall.status` (primeira linha: `running`, `done` ou `failed`; depois data e detalhe) e o log em `~/.atlas/install.log`.
4. `prepare` e `reinstall` são internos: recusados quando chamados via sudo.

### Volume do home (`packages/sandbox/src/docker-manager.ts`)
`sandboxBinds` monta, nesta ordem, perfil do Chrome, **`atlas-home-<hash>` em `/home/atlas`** e o volume de trabalho em `/home/atlas/work` (aninhado: o Docker monta por profundidade e o work cobre a pasta dentro do home). Na primeira montagem de um volume nomeado vazio o Docker copia o conteúdo que a imagem tem naquele caminho (sem `nocopy`), com os donos, então o home nasce com o `.bashrc`, o `.profile` e a pasta `work` da imagem. A flag `SANDBOX_PROFILE_VOLUMES=0` desliga os três volumes (e, sem volumes, nada persiste nem é registrado). "Limpar sessão do navegador" (`clearBrowserProfile`) continua apagando só o volume do perfil: não leva programas nem arquivos do bot.

### Agente (`packages/agent-runtime`)
As regras entram só no procedimento do grupo `shell` (`P_INSTALL` em `context/prompt-blocks.ts`), carregado pela intenção (`intent-router.ts`: "instala o programa…", `.deb`, AppImage, `apt-get`, `nvm`…) ou a pedido do modelo (palavras novas e `hint` do grupo em `native-tools.ts`). O prompt sempre carregado não mudou ("Bom dia" continua pequeno). Regras (em inglês, para o modelo): o instalador só confere argumentos e o pacote roda como root na VM, então instalar só o que o usuário pediu ou pacote conhecido; instalar com `sudo atlas-install apt|deb`; pip/npm/nvm vão para o home e persistem; ler o `.sh` antes de rodar; conferir `file`, arquitetura e plataforma antes de executar; `.exe` só no Wine sem garantia, `.dmg` não roda, e sugerir alternativa; arquivo de origem desconhecida só se o usuário pedir; confirmar antes de apagar ou sobrescrever algo do usuário; consultar `sudo atlas-install list`; instalação longa com `background:true` e `sandbox_shell_wait`.

## Riscos
- **Root dentro do container (risco aceito).** Quem consegue instalar um `.deb` consegue rodar o `postinst` como root: o `atlas-install deb` dá, por desenho, root no container a quem controla o arquivo (e o apt de um repositório do Debian também roda scripts de instalação). Contido porque o container segue sem `Privileged`, sem `CapAdd`, sem socket do Docker e na mesma rede e limites (memória/CPU) de antes; nada disso foi tocado. O que o sudo amplo permitiria a mais (qualquer comando como root, sem o filtro) não é possível. A fronteira de segurança continua sendo o container, não o usuário `atlas`. O shell `atlas` já podia ler os cookies do Chrome logado pelo CDP em 127.0.0.1:9222 (recurso documentado no README), então root na VM não cria exposição nova de login. Por isso o prompt manda tratar `.deb`, AppImage e script de origem desconhecida como pedido explícito do usuário, nunca de uma página, e-mail ou arquivo (injeção de prompt).
- **`no-new-privileges` quebraria o sudo** (o binário é setuid). A VM do bot hoje não o usa (os containers do code-runner e do dev-sandbox usam, e não mudam). Se alguém ligá-lo na VM, o `sudo atlas-install` falha com "effective uid is not 0"; o teste estático `install/image.test.mjs` guarda que o `docker-manager.ts` não o define.
- **Disco por bot.** O home não tem cota: `nvm`, caches do pip e AppImage podem crescer sem limite (a pasta de `.deb` guardados tem teto de 2 GiB). Volume só some se alguém o apagar à mão. Acompanhar `docker system df -v`; cota por volume exige driver próprio e ficou fora.
- **Primeira ligada mais lenta depois de recriar.** A reinstalação baixa os pacotes de novo (até 15 min, em segundo plano, com `nice`); nesse tempo o programa ainda não existe. O agente vê `running` no status e pode esperar ou avisar. Sem internet, o `apt` não reinstala (`failed`); `.deb` guardado ainda reinstala se as dependências já estiverem na imagem.
- **Volume de home antigo e imagem nova.** O Docker só copia a imagem para o volume vazio. Arquivos que a imagem passar a trazer em `/home/atlas` depois não chegam a bots que já têm o volume (use `/etc/skel`/`/usr/local` para o que for novo).
- **Deploy com versões mistas.** Sem migration. API/worker novos com imagem velha: o volume de home é montado por cima de uma imagem sem o `atlas-install` (sem efeito, o bot só não consegue instalar). Imagem nova com API velha: a VM sobe sem o volume de home, o `prepare` cria `.atlas` no container e o registro se perde na recriação (volta ao comportamento atual). VMs já criadas ganham o volume quando recriadas.
- **Instalação interrompida.** Se o passo de shell do agente expira (170 s) no meio de um `apt-get`, o dpkg pode ficar pela metade; a próxima chamada roda `dpkg --configure -a` antes. Por isso a regra do agente manda usar `background:true`.
- **Adulteração do registro.** O `atlas` pode trocar `.atlas` por uma pasta dele: o registro recomeça vazio (perde a reinstalação, nunca executa nada de fora). Coberto por teste.

## Custo
Infra: um volume Docker a mais por bot (KB no início; cresce com o que o bot instalar), sem processo novo em execução. Tempo: a reinstalação roda em segundo plano até 15 min só quando há pacotes no registro. Tokens: nenhum no uso normal; ~500 tokens a mais só quando o grupo `shell` é carregado.

## Como testar
- `node --test docker/agent-sandbox/install/atlas-install.test.mjs docker/agent-sandbox/install/image.test.mjs` (validação de nomes e caminhos, link simbólico para fora, `..`, registro adulterado, reinstalação ignora entrada forjada, sudoers só com o atlas-install, ordem do entrypoint). Entram em `pnpm test:scripts` e no CI.
- `pnpm --filter @workspace/sandbox test` (`sandboxBinds` com o home, limpeza do perfil não apaga home nem work).
- `pnpm --filter @workspace/agent-runtime test` (`context/install-prompt.test.ts`, `computer-use.economy-replay.test.ts`, hash do prompt legado).
- Não coberto por teste automático: o build real da imagem e o `sudo` de verdade (ver abaixo).

## Conferir à mão depois do deploy (não validado em container real)
O ambiente de desenvolvimento não tinha daemon Docker. Com a imagem reconstruída:
1. `docker exec -u atlas <vm> sudo -n atlas-install apt htop` instala; `sudo -n apt-get update` e `sudo -n bash` são recusados.
2. `docker exec -u atlas <vm> sudo -n atlas-install apt -o x`, `... apt "a b"` e `... apt "x;id"` recusam com código 65 (`echo $?`).
3. Instale algo, `docker rm -f <vm>`, abra a conversa de novo: `cat ~/.atlas/reinstall.status` passa de `pending`/`running` para `done` e o programa existe; `~/.local/bin` e o `nvm` continuam.
4. `docker volume ls | grep atlas-home-` mostra o volume novo por bot.

## Decisão: quando o pedido carrega o grupo shell
Além das frases com "programa/pacote/.deb/AppImage", qualquer "instala/instale/instalar/instalo/install + algo" carrega o grupo no passo 1 ("instala o VLC", "instale o Spotify", "instala o Chrome"). Exceção: frase que fala de celular, telefone, iPhone, Android, iOS, mobile, phone, smartphone ou tablet ("instala o app no celular", "como instalo o app no iPhone") não carrega. Falso positivo aceito: "instala o app do Atlas no computador" ou "instale as dependências do repositório" também carregam o grupo (custo: o procedimento do shell, ~1,1k caracteres, e o navegador que vem junto); errar para carregar é mais barato que o bot não saber instalar. Coberto em `context/install-prompt.test.ts`.
