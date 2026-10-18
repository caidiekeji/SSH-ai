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
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            app.manage(AppState::new(handle, data_dir));
            Ok(())
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
            commands::parse_preview,
            // Server dashboard (user-initiated exec, never AI-driven)
            commands::exec_oneshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
