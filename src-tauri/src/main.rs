//! AI SSH Assistant — application entry.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_ssh_assistant_lib::run()
}
