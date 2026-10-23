//! Janela principal: abre a página local (splash/offline), que troca para o Atlas quando ele responde.

use std::path::Path;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;
use url::Url;

use crate::navigation::{decide_navigation, NavDecision};
use crate::settings::Settings;

pub const MAIN_WINDOW: &str = "main";

/// Lembra posição, tamanho e maximizado, mas não "escondida": o app sempre abre com a janela à vista.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

/// Caminho da página local com o alvo e o settings.json na query (a página não usa IPC).
pub fn boot_path(target: &Url, settings_path: &Path) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("target", target.as_str())
        .append_pair("settings", &settings_path.to_string_lossy())
        .finish();
    format!("index.html?{query}")
}

pub fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
    settings_path: &Path,
) -> tauri::Result<WebviewWindow<R>> {
    let atlas_for_nav = settings.atlas_url.clone();
    let atlas_for_popup = settings.atlas_url.clone();
    let app_for_nav = app.clone();
    let app_for_popup = app.clone();

    let window = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        WebviewUrl::App(boot_path(&settings.atlas_url, settings_path).into()),
    )
    .title("Atlas")
    .inner_size(1200.0, 800.0)
    .min_inner_size(420.0, 520.0)
    .center()
    .on_navigation(move |url| match decide_navigation(url, &atlas_for_nav) {
        NavDecision::Allow => true,
        NavDecision::OpenExternal => {
            open_external(&app_for_nav, url);
            false
        }
        NavDecision::Block => {
            eprintln!("[atlas] navegação bloqueada: {}", url.scheme());
            false
        }
    })
    // window.open / target=_blank: nada de janelas soltas. Atlas abre na janela principal,
    // links externos vão para o navegador.
    .on_new_window(move |url, _features| {
        match decide_navigation(&url, &atlas_for_popup) {
            NavDecision::Allow => {
                if let Some(main) = app_for_popup.get_webview_window(MAIN_WINDOW) {
                    let _ = main.navigate(url);
                }
            }
            NavDecision::OpenExternal => open_external(&app_for_popup, &url),
            NavDecision::Block => eprintln!("[atlas] janela nova bloqueada: {}", url.scheme()),
        }
        NewWindowResponse::Deny
    })
    .build()?;

    // Fechar no X esconde na bandeja: o atalho global e o menu continuam funcionando.
    // Para sair de verdade: bandeja → Sair.
    let to_hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = to_hide.hide();
        }
    });

    Ok(window)
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("[atlas] não foi possível abrir o navegador: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_path_codifica_alvo_e_caminho() {
        let target = Url::parse("https://atlas.exemplo.com/p?x=1&y=2").unwrap();
        let path = Path::new(r"C:\Users\Zé\AppData\Roaming\com.atlasagent.desktop\settings.json");
        let boot = boot_path(&target, path);
        assert!(boot.starts_with("index.html?target="));
        let query = boot.split_once('?').unwrap().1;
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        assert_eq!(
            pairs[0],
            ("target".into(), "https://atlas.exemplo.com/p?x=1&y=2".into())
        );
        assert_eq!(pairs[1].1, path.to_string_lossy());
        assert_eq!(pairs.len(), 2);
    }
}
