//! Atlas desktop (etapa 1, #97): janela para o Atlas web hospedado, bandeja, atalho global e updater.
//! Ver docs/adr/0001-app-desktop-tauri.md.

mod navigation;
mod security_audit;
mod settings;
mod tray;
mod updater;
mod window;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::settings::{compiled_atlas_url, load_settings, Settings, SETTINGS_FILENAME};
use crate::window::{create_main_window, show_main_window, window_state_flags};

pub fn run() {
    tauri::Builder::default()
        // Precisa ser o primeiro plugin: a segunda execução só traz a janela existente para a frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        show_main_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings_path = app.path().app_config_dir()?.join(SETTINGS_FILENAME);
            let (settings, warnings) = load_settings(&settings_path, &compiled_atlas_url());
            for warning in &warnings {
                eprintln!("[atlas] settings: {warning}");
            }

            create_main_window(&handle, &settings, &settings_path)?;
            tray::build_tray(&handle)?;
            register_shortcut(&handle, &settings);

            if !cfg!(debug_assertions) {
                updater::spawn_check(handle.clone(), false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Atlas desktop");
}

/// Atalho ocupado por outro app ou inválido não impede o app de abrir: só avisa no log.
fn register_shortcut<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let Some(shortcut) = settings.global_shortcut.as_deref() else {
        return;
    };
    if let Err(e) = app.global_shortcut().register(shortcut) {
        eprintln!("[atlas] atalho global \"{shortcut}\" indisponível: {e}");
    }
}
