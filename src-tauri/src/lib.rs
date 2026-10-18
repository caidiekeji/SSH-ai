//! AI SSH Assistant library root.
//!
//! Security posture (PRD §1.2 hard constraints):
//! - HC-02: secrets only in the OS keychain, never in files/logs.
//! - HC-03: AI output is pure data; no code path executes commands.
//! - HC-04: LLM traffic goes directly to the user's base_url.
//! - HC-05: raw PTY bytes are normalized before any LLM sees them.

mod ai;
mod commands;
mod keyring_store;
mod pipeline;
mod provider;
mod safety;
mod ssh;
mod state;

use state::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub fn run() {
    tauri::Builder::default()
        // Single instance: launching the exe again focuses the existing window
        // instead of spawning a second process (which would add a second tray icon).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            app.manage(AppState::new(handle, data_dir));

            // System tray: closing the window hides to tray; quitting happens
            // only through the tray menu (user requirement #1).
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("AI SSH Assistant")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Close button → hide to tray instead of exiting.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // SSH
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::terminal_write,
            commands::terminal_resize,
            // Connections
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::has_saved_password,
            commands::delete_saved_password,
            // Known hosts
            commands::list_known_hosts,
            commands::remove_known_host,
            commands::host_key_respond,
            // Providers
            commands::list_provider_specs,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::has_api_key,
            commands::fetch_models,
            commands::test_provider,
            // Safety
            commands::assess_risk,
            commands::prefill_command,
            commands::list_whitelist,
            commands::add_whitelist,
            commands::remove_whitelist,
            // Diagnosis
            commands::ai_diagnose,
            commands::get_system_prompt,
            commands::set_system_prompt,
            commands::get_diagnosis_depth,
            commands::set_diagnosis_depth,
            commands::delete_api_key,
            commands::parse_preview,
            // Server dashboard (user-initiated exec, never AI-driven)
            commands::exec_oneshot,
            // Private key upload (file stored in app-private dir)
            commands::save_uploaded_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
