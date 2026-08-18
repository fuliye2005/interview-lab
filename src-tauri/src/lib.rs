mod audio;

use audio::{start_system_audio_capture, stop_system_audio_capture, AudioCaptureState};
use blake2::{Blake2b512, Digest};
use keyring::Entry;
use rand::RngCore;
use tauri_plugin_sql::{Migration, MigrationKind};

const DATABASE_PATH: &str = "sqlite:interview-lab.db";
const KEYRING_SERVICE: &str = "Interview Lab";
const KEYRING_USER: &str = "stronghold-vault-password";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_vault_password() -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let password = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            entry.set_password(&password).map_err(|error| error.to_string())?;
            Ok(password)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn stronghold_password(password: &str) -> Vec<u8> {
    let mut hasher = Blake2b512::new();
    hasher.update(b"interview-lab-stronghold-v1");
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    digest[..32].to_vec()
}

fn database_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_persistent_state_tables",
        sql: "CREATE TABLE IF NOT EXISTS app_documents (document_key TEXT PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS interview_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL, source_session_id TEXT, carried_turn_count INTEGER NOT NULL DEFAULT 0, asr_name TEXT NOT NULL, llm_name TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_interview_sessions_updated_at ON interview_sessions(updated_at DESC); CREATE TABLE IF NOT EXISTS storage_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, reason TEXT NOT NULL, settings_payload TEXT NOT NULL, materials_payload TEXT NOT NULL, history_payload TEXT NOT NULL);",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioCaptureState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_PATH, database_migrations())
                .build(),
        )
        .plugin(tauri_plugin_stronghold::Builder::new(stronghold_password).build())
        .invoke_handler(tauri::generate_handler![greet, get_vault_password, start_system_audio_capture, stop_system_audio_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
