# Atlas desktop (`@workspace/desktop`)

App desktop do Atlas em **Tauri 2**, por enquanto **só para Windows 10/11**. É a etapa 1 (#97) do
[ADR 0001](../../docs/adr/0001-app-desktop-tauri.md): uma janela que abre o Atlas web hospedado
(`ATLAS_URL`), com ícone na bandeja, atalho global e atualização automática assinada. O uso do
computador pelo bot (túnel, controle) vem nas próximas etapas.

## O que tem nesta etapa

- Janela principal com o Atlas web. Tamanho, posição e "maximizado" são lembrados entre aberturas.
- Uma instância só: abrir o app de novo traz a janela que já está aberta para a frente.
- Fechar no **X** esconde a janela na bandeja (o atalho continua funcionando). Para sair: bandeja → **Sair**.
- **Bandeja:** Abrir Atlas · Pausar uso do computador (desabilitado, "disponível em breve") ·
  Verificar atualizações · Sair. Clique esquerdo no ícone abre a janela.
- **Atalho global:** `Ctrl+Shift+Space` mostra e foca a janela (configurável no `settings.json`).
- **Página offline** em pt-BR quando o Atlas não responde, com "Tentar de novo" e nova tentativa automática.
- Links para fora do Atlas abrem no navegador padrão.
- Ao abrir (só em release), procura atualização e pergunta antes de instalar.

## Estrutura

```
apps/desktop/
├── src/                 página local (splash/offline): index.html, styles.css, boot.ts, connect.ts (+ testes)
├── scripts/             build-frontend.mjs: compila o TS e copia para dist/
└── src-tauri/
    ├── tauri.conf.json  janela, CSP, instalador NSIS, updater (pubkey + endpoint)
    ├── build.rs         valida ATLAS_URL no build
    └── src/
        ├── lib.rs           plugins e setup
        ├── settings.rs      settings.json com padrões (testes)
        ├── navigation.rs    o que fica na janela, o que vai para o navegador (testes)
        ├── window.rs        janela principal, esconder na bandeja
        ├── tray.rs          menu da bandeja
        ├── updater.rs       verificar/instalar atualização
        └── security_audit.rs  testes que travam a configuração de segurança
```

## Rodar no Windows (desenvolvimento)

Pré-requisitos (uma vez):

1. **Node 22** e **pnpm** (`corepack enable`).
2. **Rust** pelo [rustup](https://rustup.rs) (toolchain `stable-x86_64-pc-windows-msvc`, o padrão no Windows).
3. **Microsoft C++ Build Tools** (Visual Studio Installer → "Desenvolvimento para desktop com C++").
4. **WebView2**: já vem no Windows 11 e nos Windows 10 atualizados. Se faltar, instale o
   "Evergreen Bootstrapper" da Microsoft. O instalador do Atlas baixa sozinho se precisar.

Na raiz do repositório:

```powershell
pnpm install
# Atlas web local (http://localhost:3000), em outro terminal:
pnpm dev
# App desktop apontando para o padrão de dev (http://localhost:3000):
pnpm --filter @workspace/desktop tauri dev
```

Para apontar para o Atlas hospedado no build, defina `ATLAS_URL` antes (só `https://`, ou
`http://localhost`/`127.0.0.1` em dev):

```powershell
$env:ATLAS_URL = "https://seu-atlas.exemplo.com"
pnpm --filter @workspace/desktop tauri dev
```

Instalador local (sem a chave do updater; `tauri.unsigned.conf.json` só desliga os artefatos assinados):

```powershell
pnpm --filter @workspace/desktop tauri build --bundles nsis --config src-tauri/tauri.unsigned.conf.json
# sai em apps/desktop/src-tauri/target/release/bundle/nsis/Atlas_<versão>_x64-setup.exe
```

### Configurações locais (`settings.json`)

Na primeira execução o app cria `%APPDATA%\com.atlasagent.desktop\settings.json`:

```json
{
  "atlasUrl": "https://seu-atlas.exemplo.com/",
  "globalShortcut": "CommandOrControl+Shift+Space"
}
```

- `atlasUrl`: troca o endereço embutido no build. Inválido (não `https`, com usuário/senha…) → usa o padrão.
- `globalShortcut`: outro atalho (ex.: `Alt+Space`), ou `null`/`""` para desligar. Se outro app já
  usa o atalho, o Atlas abre normalmente, só sem atalho.
- Mudou? Feche pela bandeja (**Sair**) e abra de novo.

### Testes

```bash
pnpm --filter @workspace/desktop typecheck
pnpm --filter @workspace/desktop test          # página local (node:test)
pnpm --filter @workspace/desktop build:frontend # precisa existir dist/ para compilar o Rust
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

O Rust **não** entra no `turbo typecheck`/`pnpm test` da raiz (é pesado); roda no workflow
`.github/workflows/desktop.yml`. No Linux, o `cargo test` precisa de `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev` e `libxdo-dev`.

## Segurança

- A origem remota (`ATLAS_URL`) **não tem acesso a nenhum comando do Tauri**: o app não declara
  nenhuma capability (nem `remote`). Plugins (updater, atalho, opener, janela) só são usados pelo
  Rust. `withGlobalTauri` desligado. Os testes em `security_audit.rs` falham se isso mudar.
- Sem plugins de shell, fs, http ou process.
- A página local tem CSP restrita (`script-src 'self'`, sem `unsafe-eval`, `object-src 'none'`) e
  não usa IPC: recebe o alvo pela query string e valida que é `http(s)`.
- Navegação: na janela só ficam a mesma origem do `atlasUrl`, as páginas locais e o login do Google.
  Outros links `http(s)`, `mailto:` e `tel:` abrem no navegador; `file:`, `data:`, `javascript:` e
  protocolos de outros apps são bloqueados. `window.open` nunca cria janela solta.
- Atualizações só são instaladas se a assinatura bater com a chave pública do `tauri.conf.json`.

## Atualizações: chave de assinatura (uma vez)

O updater do Tauri assina cada versão com uma chave própria e gratuita. Ela **não** tira o aviso
do SmartScreen (isso é o certificado de código, que não usamos), mas garante que o app só instala
pacotes gerados por nós.

1. Gere a chave **fora do repositório** e guarde a senha num gerenciador de senhas:

   ```powershell
   pnpm --filter @workspace/desktop tauri signer generate -w "$env:USERPROFILE\.tauri\atlas-desktop.key"
   ```

   Isso cria `atlas-desktop.key` (privada) e `atlas-desktop.key.pub` (pública).
   **Nunca** commite a chave privada nem a senha. Perdeu a chave? Os apps instalados não aceitam
   mais atualizações: o usuário teria de reinstalar.
2. Copie o conteúdo de `atlas-desktop.key.pub` para `plugins.updater.pubkey` em
   `apps/desktop/src-tauri/tauri.conf.json` (no lugar de `SUBSTITUA_PELA_CHAVE_PUBLICA…`) e commite.
3. No GitHub: **Settings → Secrets and variables → Actions**:
   - *Secrets*: `TAURI_SIGNING_PRIVATE_KEY` = conteúdo de `atlas-desktop.key`;
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = a senha.
   - *Variables*: `ATLAS_DESKTOP_URL` = endereço do Atlas hospedado (`https://…`).

## Lançar uma versão

1. Suba a versão em `apps/desktop/package.json` (é a versão do app; o `Cargo.toml` não é usado para isso).
2. Commit, merge na `main` e crie a tag:

   ```bash
   git tag desktop-v0.1.0
   git push origin desktop-v0.1.0
   ```

3. O workflow **Desktop** confere tag × versão, chave pública, segredos e `ATLAS_DESKTOP_URL`;
   compila no `windows-latest`; cria o release `desktop-v0.1.0` (sem marcar como "latest" do
   repositório, que é do Atlas web) com o instalador, a `.sig` e o `latest.json`; e atualiza o
   release fixo **`desktop-latest`** com `Atlas_x64-setup.exe` e `latest.json`.
   Tags com `-` (ex.: `desktop-v0.2.0-beta.1`) saem como pré-release e **não** mexem no `desktop-latest`.

Em PR que mexe em `apps/desktop`, o mesmo workflow só testa e compila (sem publicar) e deixa o
instalador como artefato do run por 7 dias.

## Links para a página de download (landing)

Use sempre o release fixo, que não muda de endereço entre versões:

- Instalador: `https://github.com/ali-ali18/Atlas/releases/download/desktop-latest/Atlas_x64-setup.exe`
- Página com notas e versões anteriores: `https://github.com/ali-ali18/Atlas/releases/tag/desktop-latest`

Por que não `releases/latest/download/<arquivo>`? O "latest" do GitHub é o release mais recente do
**repositório inteiro**, e as tags `v*` do Atlas web também criam releases: o link quebraria a cada
release do web. O updater usa o mesmo release fixo (`desktop-latest/latest.json`).

## Para quem instala (texto para a landing)

> **O Windows mostrou "O Windows protegeu o computador"?** Clique em **Mais informações** e depois
> em **Executar assim mesmo**.
>
> O aviso aparece porque o instalador não tem um certificado de assinatura de código pago, então o
> SmartScreen ainda não "conhece" o Atlas. Não é sinal de vírus. As atualizações automáticas são
> verificadas por uma assinatura própria do Atlas: o app só instala versões publicadas por nós.
>
> O Atlas instala só para o seu usuário (não pede administrador) e aparece no Menu Iniciar. Para
> desinstalar: Configurações → Apps → Atlas.

## Limitações conhecidas (etapa 1)

- **Login:** o link mágico do e-mail abre no navegador, não no app. O login com Google acontece na
  própria janela (permitido em `navigation.rs`), mas o Google pode recusar webviews embutidas. O
  login por navegador com deep link `atlas://` é a etapa #99.
- Se a conexão cair **depois** que o Atlas abriu, a navegação mostra o erro do próprio WebView2
  (a página offline do app só aparece ao abrir o app).
- Sem MSI, sem macOS/Linux publicados (o Rust é testado no Ubuntu do CI).
- "Pausar" na bandeja é só um placeholder até o túnel de controle existir.
