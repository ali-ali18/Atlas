//! Atualização pelo tauri-plugin-updater (GitHub Releases + assinatura com a chave do Tauri).
//!
//! O pacote baixado só é instalado se a assinatura bater com a `pubkey` do tauri.conf.json:
//! isso independe de certificado de código (o app sai sem assinatura do Windows).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

static CHECKING: AtomicBool = AtomicBool::new(false);

/// Marcador do tauri.conf.json enquanto a chave pública não foi gerada.
const PUBKEY_PLACEHOLDER: &str = "SUBSTITUA_PELA_CHAVE_PUBLICA";

pub fn is_pubkey_configured(pubkey: &str) -> bool {
    let trimmed = pubkey.trim();
    !trimmed.is_empty() && !trimmed.contains(PUBKEY_PLACEHOLDER)
}

fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Verifica em segundo plano. `interactive` = pedido pelo usuário (mostra "sem novidades" e erros);
/// senão (na abertura) só fala algo se houver versão nova.
pub fn spawn_check<R: Runtime>(app: AppHandle<R>, interactive: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Thread própria: os diálogos bloqueiam e não podem rodar na thread da interface.
    std::thread::spawn(move || {
        if let Err(message) = check(&app, interactive) {
            eprintln!("[atlas] atualização: {message}");
            if interactive {
                info(
                    &app,
                    MessageDialogKind::Error,
                    &format!("Não foi possível verificar atualizações.\n\n{message}"),
                );
            }
        }
        CHECKING.store(false, Ordering::SeqCst);
    });
}

fn check<R: Runtime>(app: &AppHandle<R>, interactive: bool) -> Result<(), String> {
    if !is_pubkey_configured(&configured_pubkey(app)) {
        return Err("esta versão foi gerada sem a chave de atualização".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
    let Some(update) = found else {
        if interactive {
            let current = app.package_info().version.to_string();
            info(
                app,
                MessageDialogKind::Info,
                &format!("Você já está na versão mais recente ({current})."),
            );
        }
        return Ok(());
    };

    let question = format!(
        "Nova versão do Atlas disponível: {} (você tem {}).\n\nInstalar agora? O Atlas vai fechar e abrir de novo.",
        update.version, update.current_version
    );
    let accepted = app
        .dialog()
        .message(question)
        .title("Atualização do Atlas")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Instalar".into(), "Depois".into()))
        .blocking_show();
    if !accepted {
        return Ok(());
    }

    tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})).map_err(|e| e.to_string())?;
    app.restart();
}

fn info<R: Runtime>(app: &AppHandle<R>, kind: MessageDialogKind, message: &str) {
    app.dialog()
        .message(message)
        .title("Atlas")
        .kind(kind)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubkey_vazia_ou_placeholder_nao_vale() {
        assert!(!is_pubkey_configured(""));
        assert!(!is_pubkey_configured("   "));
        assert!(!is_pubkey_configured(PUBKEY_PLACEHOLDER));
        assert!(is_pubkey_configured(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QK"
        ));
    }

    #[test]
    fn tauri_conf_ainda_com_placeholder_ou_chave_valida() {
        // Garante que o campo existe e é texto: o release falha cedo se continuar placeholder.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().expect("pubkey é texto");
        assert!(!pubkey.trim().is_empty());
    }
}
