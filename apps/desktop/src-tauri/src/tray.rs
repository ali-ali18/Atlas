//! Ícone na bandeja do sistema.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};
use tauri_plugin_window_state::AppHandleExt;

use crate::updater;
use crate::window::{show_main_window, window_state_flags};

const ID_OPEN: &str = "open";
const ID_PAUSE: &str = "pause";
const ID_UPDATES: &str = "updates";
const ID_QUIT: &str = "quit";

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ID_OPEN, "Abrir Atlas", true, None::<&str>)?;
    // Placeholder das próximas etapas (uso do computador). Menus nativos não têm tooltip,
    // então o aviso vai no próprio texto.
    let pause = MenuItem::with_id(
        app,
        ID_PAUSE,
        "Pausar uso do computador (disponível em breve)",
        false,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(app, ID_UPDATES, "Verificar atualizações", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Atlas")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            ID_OPEN => show_main_window(app),
            ID_UPDATES => updater::spawn_check(app.clone(), true),
            ID_QUIT => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn quit_app<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = app.save_window_state(window_state_flags()) {
        eprintln!("[atlas] não foi possível salvar o estado da janela: {e}");
    }
    app.exit(0);
}
