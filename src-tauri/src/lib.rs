mod audio;

use audio::{pause_system_audio_capture, resume_system_audio_capture, start_system_audio_capture, stop_system_audio_capture, AudioCaptureState};
use blake2::{Blake2b512, Digest};
use keyring::Entry;
use rand::RngCore;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, Runtime,
};
use tauri_plugin_sql::{Migration, MigrationKind};

const DATABASE_PATH: &str = "sqlite:interview-lab.db";
const KEYRING_SERVICE: &str = "Interview Lab";
const KEYRING_USER: &str = "stronghold-vault-password";
const EXTERNAL_BACKUP_PREFIX: &str = "interview-lab-snapshot-";

#[derive(Debug, Deserialize)]
struct TrayProfile {
    id: String,
    name: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct TrayProfilesPayload {
    active_id: String,
    profiles: Vec<TrayProfile>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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

fn external_backup_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("backups");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建外部备份目录：{error}"))?;
    Ok(directory)
}

#[tauri::command]
fn write_external_snapshot(app: AppHandle, payload: String) -> Result<(), String> {
    let directory = external_backup_dir(&app)?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_micros();
    let path = directory.join(format!("{EXTERNAL_BACKUP_PREFIX}{timestamp}.json"));
    let temporary = directory.join(format!("{EXTERNAL_BACKUP_PREFIX}{timestamp}.json.tmp"));
    fs::write(&temporary, payload.as_bytes()).map_err(|error| format!("无法写入外部快照：{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法提交外部快照：{error}"))?;
    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取外部备份目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(EXTERNAL_BACKUP_PREFIX) && name.ends_with(".json")
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    while entries.len() > 5 {
        if let Some(entry) = entries.first() {
            let _ = fs::remove_file(entry.path());
        }
        entries.remove(0);
    }
    Ok(())
}

#[tauri::command]
fn read_latest_external_snapshot(app: AppHandle) -> Result<Option<String>, String> {
    let directory = external_backup_dir(&app)?;
    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取外部备份目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(EXTERNAL_BACKUP_PREFIX) && name.ends_with(".json")
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries.iter().rev() {
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let valid_format = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|value| value.get("format").and_then(serde_json::Value::as_str).map(|format| format == "interview-lab-snapshot"))
            .unwrap_or(false);
        if valid_format { return Ok(Some(content)); }
    }
    Ok(None)
}

#[tauri::command]
fn isolate_corrupt_database(app: AppHandle) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let database = data_dir.join("interview-lab.db");
    let companions = [data_dir.join("interview-lab.db-wal"), data_dir.join("interview-lab.db-shm")];
    if !database.exists() && companions.iter().all(|path| !path.exists()) { return Ok(None); }
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
    let mut first_backup: Option<PathBuf> = None;
    if database.exists() {
        let backup = database.with_file_name(format!("interview-lab.db.corrupt-{timestamp}"));
        fs::rename(&database, &backup).map_err(|error| format!("无法隔离损坏数据库：{error}"))?;
        first_backup = Some(backup);
    }
    for (suffix, companion) in [("-wal", &companions[0]), ("-shm", &companions[1])] {
        if companion.exists() {
            let companion_backup = data_dir.join(format!("interview-lab.db.corrupt-{timestamp}{suffix}"));
            fs::rename(companion, &companion_backup).map_err(|error| format!("无法隔离数据库伴随文件：{error}"))?;
            if first_backup.is_none() { first_backup = Some(companion_backup); }
        }
    }
    Ok(first_backup.map(|path| path.to_string_lossy().to_string()))
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>, payload: &TrayProfilesPayload) -> tauri::Result<tauri::menu::Menu<R>> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let header = MenuItem::with_id(app, "model-header", "切换当前文本模型", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Interview Lab", true, None::<&str>)?;
    let mut profile_items = Vec::with_capacity(payload.profiles.len());
    for profile in &payload.profiles {
        let marker = if profile.id == payload.active_id { "✓ " } else { "" };
        let model = if profile.model.trim().is_empty() { "未填写模型" } else { profile.model.as_str() };
        profile_items.push(MenuItem::with_id(
            app,
            format!("profile:{}", profile.id),
            format!("{marker}{} · {model}", profile.name),
            true,
            None::<&str>,
        )?);
    }
    let mut menu = MenuBuilder::new(app).item(&show).separator().item(&header);
    for item in &profile_items {
        menu = menu.item(item);
    }
    menu.separator().item(&quit).build()
}

fn database_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_persistent_state_tables",
            sql: "CREATE TABLE IF NOT EXISTS app_documents (document_key TEXT PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS interview_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL, source_session_id TEXT, carried_turn_count INTEGER NOT NULL DEFAULT 0, asr_name TEXT NOT NULL, llm_name TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_interview_sessions_updated_at ON interview_sessions(updated_at DESC); CREATE TABLE IF NOT EXISTS storage_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, reason TEXT NOT NULL, settings_payload TEXT NOT NULL, materials_payload TEXT NOT NULL, history_payload TEXT NOT NULL);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "record_storage_schema_v2",
            sql: "CREATE TABLE IF NOT EXISTS storage_migration_log (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL); UPDATE app_documents SET schema_version = 2 WHERE schema_version < 2; INSERT OR IGNORE INTO storage_migration_log (version, description, applied_at) VALUES (2, 'record_storage_schema_v2', datetime('now'));",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioCaptureState::default())
        .setup(|app| {
            let initial_payload = TrayProfilesPayload { active_id: String::new(), profiles: Vec::new() };
            let menu = build_tray_menu(app.handle(), &initial_payload)?;
            let app_handle = app.handle().clone();
            app.listen("tray-update-profiles", move |event| {
                let Ok(payload) = serde_json::from_str::<TrayProfilesPayload>(event.payload()) else { return; };
                let Some(tray) = app_handle.tray_by_id("main") else { return; };
                if let Ok(menu) = build_tray_menu(&app_handle, &payload) {
                    let _ = tray.set_menu(Some(menu));
                }
            });
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        let _ = app.emit("tray-quit", ());
                    }
                    id if id.starts_with("profile:") => {
                        let _ = app.emit("tray-profile-select", id.trim_start_matches("profile:"));
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_PATH, database_migrations())
                .build(),
        )
        .plugin(tauri_plugin_stronghold::Builder::new(stronghold_password).build())
        .invoke_handler(tauri::generate_handler![greet, exit_app, get_vault_password, write_external_snapshot, read_latest_external_snapshot, isolate_corrupt_database, start_system_audio_capture, pause_system_audio_capture, resume_system_audio_capture, stop_system_audio_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
