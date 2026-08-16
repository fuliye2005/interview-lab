use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use tauri::{AppHandle, Emitter, State};
use wasapi::{get_default_device, initialize_mta, Direction, SampleType, StreamMode, WaveFormat};

pub struct AudioCaptureState(pub Arc<Mutex<Option<Arc<AtomicBool>>>>);

impl Default for AudioCaptureState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

#[tauri::command]
pub fn start_system_audio_capture(app: AppHandle, state: State<'_, AudioCaptureState>) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|_| "音频采集状态锁定失败".to_string())?;
    if active.is_some() {
        return Ok(());
    }
    let running = Arc::new(AtomicBool::new(true));
    *active = Some(running.clone());
    thread::Builder::new()
        .name("system-audio-loopback".to_string())
        .spawn(move || {
            if let Err(error) = capture_loop(app.clone(), running.clone()) {
                let _ = app.emit("audio-capture-error", error);
            }
        })
        .map_err(|error| format!("无法启动音频采集线程：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn stop_system_audio_capture(state: State<'_, AudioCaptureState>) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|_| "音频采集状态锁定失败".to_string())?;
    if let Some(running) = active.take() {
        running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

fn capture_loop(app: AppHandle, running: Arc<AtomicBool>) -> Result<(), String> {
    initialize_mta().ok().map_err(|error| format!("无法初始化 Windows 音频线程：{error}"))?;
    let device = get_default_device(&Direction::Render)
        .map_err(|error| format!("无法读取默认输出设备：{error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("无法创建 WASAPI 客户端：{error}"))?;
    let desired_format = WaveFormat::new(16, 16, &SampleType::Int, 16_000, 1, None);
    let (_, min_period) = audio_client
        .get_device_period()
        .map_err(|error| format!("无法读取音频设备周期：{error}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|error| format!("无法初始化系统音频回环：{error}"))?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| format!("无法创建音频事件句柄：{error}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("无法创建音频捕获客户端：{error}"))?;
    let bytes_per_frame = desired_format.get_blockalign() as usize;
    let chunk_bytes = bytes_per_frame * 1_600;
    let mut queue = VecDeque::with_capacity(chunk_bytes * 3);
    audio_client
        .start_stream()
        .map_err(|error| format!("无法启动系统音频回环：{error}"))?;
    let _ = app.emit("audio-capture-status", "listening");

    while running.load(Ordering::SeqCst) {
        let frames = capture_client
            .get_next_packet_size()
            .map_err(|error| format!("无法读取音频包长度：{error}"))?
            .unwrap_or(0);
        if frames > 0 {
            capture_client
                .read_from_device_to_deque(&mut queue)
                .map_err(|error| format!("无法读取系统音频：{error}"))?;
        }
        while queue.len() >= chunk_bytes {
            let mut chunk = Vec::with_capacity(chunk_bytes);
            for _ in 0..chunk_bytes {
                if let Some(byte) = queue.pop_front() {
                    chunk.push(byte);
                }
            }
            let _ = app.emit("audio-pcm", chunk);
        }
        let _ = event.wait_for_event(250);
    }
    let _ = audio_client.stop_stream();
    let _ = app.emit("audio-capture-status", "stopped");
    Ok(())
}
