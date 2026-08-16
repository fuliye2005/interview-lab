mod audio;

use audio::{start_system_audio_capture, stop_system_audio_capture, AudioCaptureState};
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioCaptureState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, start_system_audio_capture, stop_system_audio_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
