use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::thread;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, SetEvent, WaitForMultipleObjects, INFINITE,
};
const PET_TRAY_TOGGLE_ID: &str = "desktop-pet-toggle";
const PLATFORM_TRAY_OPEN_ID: &str = "platform-workspace-open";
const PET_TRAY_OPEN_MAIN_ID: &str = "desktop-pet-open-main";
const PET_TRAY_DISABLE_MOUSE_THROUGH_ID: &str = "desktop-pet-disable-mouse-through";
const PET_TRAY_QUIT_ID: &str = "desktop-pet-quit";
const PET_REQUEST_EVENT: &str = "learnflow:desktop-pet-requested";
#[cfg(target_os = "windows")]
const INSTANCE_ACTIVATED_EVENT: &str = "learnflow:desktop-instance-activated";
const PET_HIDDEN_EVENT: &str = "learnflow:desktop-pet-hidden";
const PET_OCR_MAX_BYTES: u64 = 12 * 1024 * 1024;

fn default_pet_shortcut() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Command+Option+P"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Alt+P"
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeConfig {
    api_base_url: String,
    desktop_token: String,
    cloud_origin: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopPetPreferences {
    schema_version: u8,
    appearance: String,
    shortcut: String,
    review_reminders_enabled: bool,
    review_reminder_interval_minutes: u16,
    mouse_through: bool,
    edge_auto_hide: bool,
    geometry: Option<DesktopPetGeometry>,
}

impl Default for DesktopPetPreferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            appearance: "mist".into(),
            shortcut: default_pet_shortcut().into(),
            review_reminders_enabled: false,
            review_reminder_interval_minutes: 30,
            mouse_through: false,
            edge_auto_hide: false,
            geometry: None,
        }
    }
}

impl DesktopPetPreferences {
    fn normalize(&mut self) {
        self.schema_version = 1;
        if !matches!(self.appearance.as_str(), "mist" | "warm" | "dusk") {
            self.appearance = "mist".into();
        }
        if self.shortcut.trim().is_empty() || self.shortcut.parse::<Shortcut>().is_err() {
            self.shortcut = default_pet_shortcut().into();
        }
        if !matches!(self.review_reminder_interval_minutes, 15 | 30 | 60) {
            self.review_reminder_interval_minutes = 30;
        }
        if self.geometry.as_ref().is_some_and(|geometry| {
            geometry.width < 160
                || geometry.height < 180
                || geometry.width > 900
                || geometry.height > 1200
        }) {
            self.geometry = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetPreferencesUpdate {
    appearance: Option<String>,
    shortcut: Option<String>,
    review_reminders_enabled: Option<bool>,
    review_reminder_interval_minutes: Option<u16>,
    mouse_through: Option<bool>,
    edge_auto_hide: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetOcrResult {
    text: String,
    source_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetSelectionCapture {
    image_base64: String,
    mime_type: String,
    source_label: String,
    text: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetNavigation {
    request_id: String,
    path: String,
}

struct DesktopRuntimeState {
    config: DesktopRuntimeConfig,
    sidecar: Mutex<Option<CommandChild>>,
    pet_capability_token: Mutex<Option<String>>,
    pet_session_id: Mutex<Option<u64>>,
    pet_preferences: Mutex<DesktopPetPreferences>,
    pet_preferences_path: PathBuf,
}

#[tauri::command]
fn desktop_runtime_config(state: tauri::State<'_, DesktopRuntimeState>) -> DesktopRuntimeConfig {
    state.config.clone()
}

fn load_desktop_pet_preferences(path: &Path) -> DesktopPetPreferences {
    let mut preferences = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopPetPreferences>(&raw).ok())
        .unwrap_or_default();
    preferences.normalize();
    preferences
}

fn persist_desktop_pet_preferences(state: &DesktopRuntimeState) -> Result<(), String> {
    let payload = {
        let preferences = state
            .pet_preferences
            .lock()
            .map_err(|_| "桌宠本机设置锁不可用")?;
        serde_json::to_vec_pretty(&*preferences).map_err(|error| error.to_string())?
    };
    std::fs::write(&state.pet_preferences_path, payload).map_err(|error| error.to_string())
}

fn persist_desktop_pet_geometry(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("pet") else {
        return Ok(());
    };
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    {
        let state = app.state::<DesktopRuntimeState>();
        let mut preferences = state
            .pet_preferences
            .lock()
            .map_err(|_| "桌宠本机设置锁不可用")?;
        preferences.geometry = Some(DesktopPetGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        });
    }
    let state = app.state::<DesktopRuntimeState>();
    persist_desktop_pet_preferences(&state)
}

fn geometry_is_visible(window: &WebviewWindow, geometry: &DesktopPetGeometry) -> bool {
    let right = geometry
        .x
        .saturating_add(geometry.width.min(i32::MAX as u32) as i32);
    let bottom = geometry
        .y
        .saturating_add(geometry.height.min(i32::MAX as u32) as i32);
    window.available_monitors().ok().is_some_and(|monitors| {
        monitors.iter().any(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let monitor_right = position
                .x
                .saturating_add(size.width.min(i32::MAX as u32) as i32);
            let monitor_bottom = position
                .y
                .saturating_add(size.height.min(i32::MAX as u32) as i32);
            geometry.x < monitor_right
                && right > position.x
                && geometry.y < monitor_bottom
                && bottom > position.y
        })
    })
}

fn is_supported_ocr_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "bmp" | "webp")
    )
}

fn bounded_ocr_text(raw: String) -> String {
    raw.replace("\r\n", "\n")
        .trim()
        .chars()
        .take(12_000)
        .collect()
}

#[cfg(target_os = "windows")]
fn capture_foreground_window_image(target_window: Option<isize>) -> Result<String, String> {
    const CAPTURE_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LearnFlowForegroundCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$hwnd = [IntPtr]::Zero
if (-not [string]::IsNullOrWhiteSpace($env:LEARNFLOW_TARGET_HWND)) {
    $hwnd = [IntPtr]::new([Int64]$env:LEARNFLOW_TARGET_HWND)
} else {
    $hwnd = [LearnFlowForegroundCapture]::GetForegroundWindow()
}
if ($hwnd -eq [IntPtr]::Zero) { throw '没有可抓取的前台窗口。' }
$rect = New-Object LearnFlowForegroundCapture+RECT
if (-not [LearnFlowForegroundCapture]::GetWindowRect($hwnd, [ref]$rect)) { throw '无法读取前台窗口范围。' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 1 -or $height -lt 1 -or $width * $height -gt 16000000) { throw '前台窗口尺寸超出抓取限制。' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            CAPTURE_SCRIPT,
        ])
        .env(
            "LEARNFLOW_TARGET_HWND",
            target_window
                .map(|value| value.to_string())
                .unwrap_or_default(),
        )
        .output()
        .map_err(|error| format!("无法启动桌面抓取：{error}"))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if reason.is_empty() {
            "无法抓取前台窗口".into()
        } else {
            format!("无法抓取前台窗口：{reason}")
        });
    }
    let encoded = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if encoded.is_empty() {
        return Err("前台窗口抓取结果为空".into());
    }
    Ok(encoded)
}

#[cfg(target_os = "macos")]
fn capture_selection_image() -> Result<String, String> {
    let path =
        std::env::temp_dir().join(format!("learnflow-selection-{}.png", uuid::Uuid::new_v4()));
    let result = Command::new("screencapture")
        .args(["-i", "-x"])
        .arg(&path)
        .output()
        .map_err(|error| format!("无法启动 macOS 选区截图：{error}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&path);
        return Err("macOS 选区截图未完成，请检查屏幕录制权限后重试".into());
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(format!("无法读取 macOS 选区截图：{error}"));
        }
    };
    let _ = std::fs::remove_file(&path);
    if bytes.is_empty() || bytes.len() as u64 > PET_OCR_MAX_BYTES {
        return Err("macOS 选区截图为空或超过大小限制".into());
    }
    Ok(BASE64.encode(bytes))
}

#[cfg(target_os = "windows")]
fn capture_selection_image() -> Result<String, String> {
    capture_foreground_window_image(None)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_selection_image() -> Result<String, String> {
    Err("当前系统暂未提供选区截图能力".into())
}

#[cfg(target_os = "windows")]
fn run_windows_selection_text(target_window: Option<isize>) -> Result<Option<String>, String> {
    const SELECTION_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LearnFlowSelectionCapture {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$target = [IntPtr]::Zero
if (-not [string]::IsNullOrWhiteSpace($env:LEARNFLOW_TARGET_HWND)) {
    $target = [IntPtr]::new([Int64]$env:LEARNFLOW_TARGET_HWND)
}
if ($target -eq [IntPtr]::Zero) {
    $target = [LearnFlowSelectionCapture]::GetForegroundWindow()
}
$previous = $null
try { $previous = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
$beforeSequence = [LearnFlowSelectionCapture]::GetClipboardSequenceNumber()
$beforeText = $null
try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $beforeText = [System.Windows.Forms.Clipboard]::GetText()
    }
} catch {}
try {
    if ($target -ne [IntPtr]::Zero) {
        [LearnFlowSelectionCapture]::SetForegroundWindow($target) | Out-Null
    }
    Start-Sleep -Milliseconds 80
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            [System.Windows.Forms.SendKeys]::SendWait('^c')
            Start-Sleep -Milliseconds 180
            $afterSequence = [LearnFlowSelectionCapture]::GetClipboardSequenceNumber()
            if ([System.Windows.Forms.Clipboard]::ContainsText()) {
                $afterText = [System.Windows.Forms.Clipboard]::GetText()
                $changed = $afterSequence -ne $beforeSequence -or $null -eq $beforeText -or $afterText -ne $beforeText
                if ($changed -and -not [string]::IsNullOrWhiteSpace($afterText)) {
                    [Console]::Out.Write($afterText)
                    break
                }
            }
        } catch {}
    }
} finally {
    try {
        if ($null -ne $previous) {
            [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true)
        } else {
            [System.Windows.Forms.Clipboard]::Clear()
        }
    } catch {}
}
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-WindowStyle",
            "Hidden",
            "-Command",
            SELECTION_SCRIPT,
        ])
        .env(
            "LEARNFLOW_TARGET_HWND",
            target_window
                .map(|value| value.to_string())
                .unwrap_or_default(),
        )
        .output()
        .map_err(|error| format!("无法启动系统选区读取：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = bounded_ocr_text(String::from_utf8_lossy(&output.stdout).into_owned());
    Ok((!text.is_empty()).then_some(text))
}

#[cfg(target_os = "windows")]
fn run_local_ocr(path: &Path) -> Result<String, String> {
    const OCR_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
function Await-WinRt($operation, [Type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:LEARNFLOW_OCR_IMAGE_PATH)) ([Windows.Storage.StorageFile])
$stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'Windows OCR engine is unavailable.' }
$result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.Write($result.Text)
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", OCR_SCRIPT])
        .env("LEARNFLOW_OCR_IMAGE_PATH", path)
        .output()
        .map_err(|error| format!("无法启动本机 OCR：{error}"))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if reason.is_empty() {
            "本机 OCR 未能完成图片识别".into()
        } else {
            format!("本机 OCR 未能完成图片识别：{reason}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(target_os = "windows"))]
fn run_local_ocr(_path: &Path) -> Result<String, String> {
    Err("当前系统未提供本机 OCR，请直接添加截图交给账户视觉模型识别".into())
}

#[tauri::command]
async fn capture_desktop_pet_ocr(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<DesktopPetOcrResult>, String> {
    if window.label() != "pet" {
        return Err("只有桌宠可以选择截图进行 OCR".into());
    }
    let file = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("截图图片", &["png", "jpg", "jpeg", "bmp", "webp"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| format!("无法打开截图选择器：{error}"))?;
    let Some(file) = file else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| "只能识别本机选择的截图文件")?;
    if !is_supported_ocr_image(&path) {
        return Err("截图仅支持 PNG、JPG、BMP 或 WebP 图片".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| format!("无法读取截图：{error}"))?;
    if !metadata.is_file() || metadata.len() > PET_OCR_MAX_BYTES {
        return Err("截图必须是小于 12 MB 的本机图片文件".into());
    }
    let path_for_ocr = path.clone();
    let text = tauri::async_runtime::spawn_blocking(move || run_local_ocr(&path_for_ocr))
        .await
        .map_err(|error| format!("本机 OCR 任务中断：{error}"))??;
    let text = bounded_ocr_text(text);
    if text.is_empty() {
        return Err("未在截图中识别到可用文字".into());
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("截图")
        .chars()
        .take(100)
        .collect::<String>();
    Ok(Some(DesktopPetOcrResult {
        text,
        source_label: format!("用户主动选择的截图 OCR · {filename}"),
    }))
}

#[tauri::command]
async fn capture_desktop_pet_selection(
    window: WebviewWindow,
) -> Result<DesktopPetSelectionCapture, String> {
    if window.label() != "pet" {
        return Err("只有桌宠可以抓取前台选区".into());
    }
    if !window.is_visible().map_err(|error| error.to_string())? {
        return Err("桌宠对话框未打开".into());
    }
    #[cfg(target_os = "windows")]
    let native_text = tauri::async_runtime::spawn_blocking(|| run_windows_selection_text(None))
        .await
        .map_err(|error| format!("系统选区读取任务中断：{error}"))??;
    #[cfg(not(target_os = "windows"))]
    let native_text: Option<String> = None;
    if let Some(text) = native_text {
        return Ok(DesktopPetSelectionCapture {
            image_base64: String::new(),
            mime_type: "text/plain".into(),
            source_label: "用户主动读取的系统选区文字".into(),
            text: Some(text),
        });
    }
    #[cfg(target_os = "macos")]
    window.hide().map_err(|error| error.to_string())?;
    let image_result = tauri::async_runtime::spawn_blocking(capture_selection_image)
        .await
        .map_err(|error| format!("桌面抓取任务中断：{error}"));
    #[cfg(target_os = "macos")]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let image_base64 = image_result??;
    Ok(DesktopPetSelectionCapture {
        image_base64,
        mime_type: "image/png".into(),
        source_label: "用户主动抓取的系统高亮文字".into(),
        text: None,
    })
}

#[tauri::command]
fn desktop_pet_preferences(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<DesktopPetPreferences, String> {
    if window.label() != "pet" {
        return Err("该本机设置桥仅供桌宠窗口使用".into());
    }
    state
        .pet_preferences
        .lock()
        .map_err(|_| "桌宠本机设置锁不可用".to_string())
        .map(|preferences| preferences.clone())
}

#[tauri::command]
fn update_desktop_pet_preferences(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopRuntimeState>,
    update: DesktopPetPreferencesUpdate,
) -> Result<DesktopPetPreferences, String> {
    if window.label() != "pet" {
        return Err("该本机设置桥仅供桌宠窗口使用".into());
    }
    let previous_shortcut = state
        .pet_preferences
        .lock()
        .map_err(|_| "桌宠本机设置锁不可用")?
        .shortcut
        .clone();
    let preferences = {
        let mut preferences = state
            .pet_preferences
            .lock()
            .map_err(|_| "桌宠本机设置锁不可用")?;
        if let Some(appearance) = update.appearance {
            preferences.appearance = appearance;
        }
        if let Some(shortcut) = update.shortcut {
            preferences.shortcut = shortcut;
        }
        if let Some(enabled) = update.review_reminders_enabled {
            preferences.review_reminders_enabled = enabled;
        }
        if let Some(interval) = update.review_reminder_interval_minutes {
            preferences.review_reminder_interval_minutes = interval;
        }
        if let Some(mouse_through) = update.mouse_through {
            preferences.mouse_through = mouse_through;
        }
        if let Some(edge_auto_hide) = update.edge_auto_hide {
            preferences.edge_auto_hide = edge_auto_hide;
        }
        preferences.normalize();
        preferences.clone()
    };
    if let Err(error) =
        register_pet_global_shortcut(&app, &preferences.shortcut, Some(&previous_shortcut))
    {
        if let Ok(mut current) = state.pet_preferences.lock() {
            current.shortcut = previous_shortcut;
        }
        return Err(error);
    }
    window
        .set_ignore_cursor_events(preferences.mouse_through)
        .map_err(|error| error.to_string())?;
    persist_desktop_pet_preferences(&state)?;
    app.emit_to(
        "pet",
        "learnflow:desktop-pet-preferences-updated",
        &preferences,
    )
    .map_err(|error| error.to_string())?;
    Ok(preferences)
}

#[tauri::command]
fn restore_desktop_pet_geometry(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<bool, String> {
    if window.label() != "pet" {
        return Err("该本机设置桥仅供桌宠窗口使用".into());
    }
    let preferences = state
        .pet_preferences
        .lock()
        .map_err(|_| "桌宠本机设置锁不可用".to_string())?
        .clone();
    window
        .set_ignore_cursor_events(preferences.mouse_through)
        .map_err(|error| error.to_string())?;
    let Some(geometry) = preferences.geometry else {
        return Ok(false);
    };
    if !geometry_is_visible(&window, &geometry) {
        return Ok(false);
    }
    window
        .set_size(PhysicalSize::new(geometry.width, geometry.height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(geometry.x, geometry.y))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn reset_desktop_pet_geometry(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<DesktopPetPreferences, String> {
    if window.label() != "pet" {
        return Err("该本机设置桥仅供桌宠窗口使用".into());
    }
    let preferences = {
        let mut preferences = state
            .pet_preferences
            .lock()
            .map_err(|_| "桌宠本机设置锁不可用")?;
        preferences.geometry = None;
        preferences.clone()
    };
    persist_desktop_pet_preferences(&state)?;
    Ok(preferences)
}

fn hide_desktop_pet(app: &tauri::AppHandle) -> Result<(), String> {
    persist_desktop_pet_geometry(app)?;
    if let Some(window) = app.get_webview_window("pet") {
        window.hide().map_err(|error| error.to_string())?;
    }
    app.emit_to("pet", PET_HIDDEN_EVENT, ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn close_desktop_pet(app: tauri::AppHandle) -> Result<(), String> {
    hide_desktop_pet(&app)
}

fn show_desktop_main(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "LearnFlow 主窗口不可用".to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())
}

fn request_desktop_pet(app: &tauri::AppHandle) -> Result<(), String> {
    app.emit_to("main", PET_REQUEST_EVENT, ())
        .map_err(|error| error.to_string())
}

fn disable_desktop_pet_mouse_through(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopRuntimeState>();
    let preferences = {
        let mut preferences = state
            .pet_preferences
            .lock()
            .map_err(|_| "桌宠本机设置锁不可用")?;
        preferences.mouse_through = false;
        preferences.clone()
    };
    persist_desktop_pet_preferences(&state)?;
    if let Some(window) = app.get_webview_window("pet") {
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
    }
    app.emit_to(
        "pet",
        "learnflow:desktop-pet-preferences-updated",
        &preferences,
    )
    .map_err(|error| error.to_string())
}

fn toggle_desktop_pet(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        if window.is_visible().map_err(|error| error.to_string())? {
            return hide_desktop_pet(app);
        }
    }
    request_desktop_pet(app)
}

fn configure_system_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle_pet = MenuItemBuilder::with_id(PET_TRAY_TOGGLE_ID, "显示 / 隐藏桌宠").build(app)?;
    let open_platform = MenuItemBuilder::with_id(PLATFORM_TRAY_OPEN_ID, "在线学习空间").build(app)?;
    let open_main = MenuItemBuilder::with_id(PET_TRAY_OPEN_MAIN_ID, "打开 LearnFlow").build(app)?;
    let restore_mouse =
        MenuItemBuilder::with_id(PET_TRAY_DISABLE_MOUSE_THROUGH_ID, "恢复桌宠鼠标交互")
            .build(app)?;
    let quit = MenuItemBuilder::with_id(PET_TRAY_QUIT_ID, "退出 LearnFlow").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle_pet, &open_main, &open_platform, &restore_mouse])
        .separator()
        .item(&quit)
        .build()?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("默认窗口图标不可用".into()))?;
    TrayIconBuilder::with_id("learnflow-desktop")
        .tooltip("LearnFlow 桌宠")
        .menu(&menu)
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            PET_TRAY_TOGGLE_ID => {
                let _ = toggle_desktop_pet(app);
            }
            PLATFORM_TRAY_OPEN_ID => {
                if let Err(error) = show_platform_workspace(app) { eprintln!("platform window: {error}"); }
            }
            PET_TRAY_OPEN_MAIN_ID => {
                let _ = show_desktop_main(app);
            }
            PET_TRAY_DISABLE_MOUSE_THROUGH_ID => {
                let _ = disable_desktop_pet_mouse_through(app);
            }
            PET_TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let _ = toggle_desktop_pet(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
struct SingleInstanceGuard {
    activation_event: HANDLE,
    shutdown_event: HANDLE,
    listener: Option<thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
impl SingleInstanceGuard {
    fn acquire() -> Result<Option<Self>, String> {
        let name: Vec<u16> = "Local\\LearnFlowDesktopActivation-v1"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let activation_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if activation_event.is_null() {
            return Err(format!("无法创建 LearnFlow 单实例事件：{}", unsafe {
                GetLastError()
            }));
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                SetEvent(activation_event);
                CloseHandle(activation_event);
            }
            return Ok(None);
        }
        let shutdown_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if shutdown_event.is_null() {
            unsafe {
                CloseHandle(activation_event);
            }
            return Err(format!("无法创建 LearnFlow 退出事件：{}", unsafe {
                GetLastError()
            }));
        }
        Ok(Some(Self {
            activation_event,
            shutdown_event,
            listener: None,
        }))
    }

    fn start(&mut self, app: tauri::AppHandle) {
        let activation_event = self.activation_event as usize;
        let shutdown_event = self.shutdown_event as usize;
        self.listener = Some(thread::spawn(move || {
            let handles = [activation_event as HANDLE, shutdown_event as HANDLE];
            loop {
                let signaled = unsafe {
                    WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE)
                };
                if signaled == WAIT_OBJECT_0 {
                    let _ = show_desktop_main(&app);
                    let _ = app.emit_to("main", INSTANCE_ACTIVATED_EVENT, ());
                } else {
                    break;
                }
            }
        }));
    }
}

#[cfg(target_os = "windows")]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            SetEvent(self.shutdown_event);
        }
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
        unsafe {
            CloseHandle(self.activation_event);
            CloseHandle(self.shutdown_event);
        }
    }
}

fn request_desktop_pet_selection_capture(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("pet") else {
        return Ok(());
    };
    if !window.is_visible().map_err(|error| error.to_string())? {
        return Ok(());
    }
    app.emit_to(
        "pet",
        "learnflow:desktop-pet-selection-capture-requested",
        (),
    )
    .map_err(|error| error.to_string())
}

fn allowed_main_path(path: &str) -> bool {
    if matches!(path, "/tasks" | "/review" | "/learning-files") {
        return true;
    }
    for prefix in [
        "/chat/",
        "/projects/",
        "/files/lecture/",
        "/files/practice/",
    ] {
        let Some(value) = path.strip_prefix(prefix) else {
            continue;
        };
        if !value.is_empty()
            && !value.contains("..")
            && !value.contains('\\')
            && !value.contains('?')
            && !value.contains('#')
        {
            return true;
        }
    }
    false
}

#[tauri::command]
fn open_desktop_main_path(
    window: WebviewWindow,
    app: tauri::AppHandle,
    path: String,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("只有桌宠可以打开 LearnFlow 主窗口".into());
    }
    if !allowed_main_path(&path) {
        return Err("桌宠只能打开已登记的 LearnFlow 页面".into());
    }
    show_desktop_main(&app)?;
    app.emit_to(
        "main",
        "learnflow:desktop-pet-navigate",
        DesktopPetNavigation { request_id, path },
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn allowed_external_url(url: &str) -> bool {
    let value = url.trim();
    value.len() <= 4096
        && !value.chars().any(|character| character.is_control())
        && (value.starts_with("http://") || value.starts_with("https://"))
}

fn validated_platform_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "在线学习地址无效")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path() != "/" {
        return Err("在线学习地址必须是无凭据、路径或参数的 HTTPS 站点地址".into());
    }
    Ok(url)
}

fn show_platform_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("platform") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    // Only the release builder selects the online authority. Page code cannot
    // choose a destination or send local credentials to it.
    let url = validated_platform_url(option_env!("LEARNFLOW_PLATFORM_URL").unwrap_or("https://learn.learnflow.club"))?;
    let origin = url.origin();
    tauri::WebviewWindowBuilder::new(app, "platform", tauri::WebviewUrl::External(url))
        .title("LearnFlow · 在线学习空间")
        .inner_size(1440.0, 920.0)
        .min_inner_size(768.0, 600.0)
        .on_navigation(move |next| next.origin() == origin)
        .build().map_err(|e| e.to_string())?;
    // No capability file matches this remote window. It cannot use local IPC,
    // files, sidecar credentials, capture, shell or native notifications.
    Ok(())
}

#[tauri::command]
fn open_platform_workspace(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有桌面主窗口可以打开在线学习空间".into());
    }
    show_platform_workspace(&app)
}

#[tauri::command]
fn open_external_url(window: WebviewWindow, url: String) -> Result<(), String> {
    if !matches!(window.label(), "main" | "pet") {
        return Err("只有 LearnFlow 窗口可以打开外部页面".into());
    }
    if !allowed_external_url(&url) {
        return Err("外部页面必须使用有效的 HTTP 或 HTTPS 地址".into());
    }
    open::that(url).map_err(|error| error.to_string())
}

#[tauri::command]
fn store_desktop_pet_capability(
    window: WebviewWindow,
    app: tauri::AppHandle,
    token: String,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以更新桌宠受限身份".into());
    }
    if token.trim().is_empty() {
        return Err("桌宠受限身份不能为空".into());
    }
    *state
        .pet_capability_token
        .lock()
        .map_err(|_| "桌宠身份锁不可用")? = Some(token);
    app.emit("learnflow:pet-identity-updated", ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn sync_desktop_pet_session(
    window: WebviewWindow,
    app: tauri::AppHandle,
    session_id: Option<u64>,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以同步桌宠正式会话".into());
    }
    if session_id == Some(0) {
        return Err("正式 Tutor 会话标识无效".into());
    }
    *state
        .pet_session_id
        .lock()
        .map_err(|_| "桌宠会话锁不可用")? = session_id;
    if app.get_webview_window("pet").is_some() {
        app.emit_to("pet", "learnflow:desktop-pet-session-updated", session_id)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_pet_active_session(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<Option<u64>, String> {
    if window.label() != "pet" {
        return Err("该会话桥仅供桌宠窗口使用".into());
    }
    state
        .pet_session_id
        .lock()
        .map_err(|_| "桌宠会话锁不可用".to_string())
        .map(|session_id| *session_id)
}

#[tauri::command]
fn clear_desktop_auth_token(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以清除桌面身份".into());
    }
    *state
        .pet_capability_token
        .lock()
        .map_err(|_| "桌宠身份锁不可用")? = None;
    *state
        .pet_session_id
        .lock()
        .map_err(|_| "桌宠会话锁不可用")? = None;
    if let Some(pet_window) = app.get_webview_window("pet") {
        persist_desktop_pet_geometry(&app)?;
        pet_window.hide().map_err(|error| error.to_string())?;
    }
    app.emit("learnflow:pet-identity-cleared", ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn desktop_pet_auth_token(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopRuntimeState>,
) -> Result<String, String> {
    if window.label() != "pet" {
        return Err("该身份桥仅供桌宠窗口使用".into());
    }
    state
        .pet_capability_token
        .lock()
        .map_err(|_| "桌面身份锁不可用")?
        .clone()
        .ok_or_else(|| "请先在 LearnFlow 主窗口登录以授权桌宠".into())
}

fn handle_desktop_pet_global_shortcut(app: &tauri::AppHandle) {
    // 快捷键路由：桌宠可见（处于激活态）时把当前系统前台窗口的高亮文字
    // 抓给桌宠转写；桌宠尚未打开时则请求主窗口展示桌宠。
    let pet_visible = app
        .get_webview_window("pet")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if pet_visible {
        let _ = request_desktop_pet_selection_capture(app);
    } else {
        let _ = request_desktop_pet(app);
    }
}

fn register_pet_global_shortcut(
    app: &tauri::AppHandle,
    label: &str,
    previous_label: Option<&str>,
) -> Result<(), String> {
    let shortcut: Shortcut = label
        .parse()
        .map_err(|error| format!("桌宠快捷键格式无效：{error}"))?;
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|error| format!("无法更新桌宠快捷键：{error}"))?;
    if let Err(error) = manager.register(shortcut) {
        if let Some(previous) = previous_label {
            if let Ok(previous_shortcut) = previous.parse::<Shortcut>() {
                let _ = manager.register(previous_shortcut);
            }
        }
        return Err(format!(
            "无法注册桌宠快捷键 {label}，可能已被其他应用占用：{error}"
        ));
    }
    Ok(())
}

fn reserve_loopback_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .expect("failed to reserve a loopback port")
        .port()
}

pub fn run() {
    #[cfg(target_os = "windows")]
    let mut single_instance = match SingleInstanceGuard::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            eprintln!("LearnFlow 单实例保护不可用：{error}");
            return;
        }
    };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event: ShortcutEvent| {
                    if event.state == ShortcutState::Pressed {
                        handle_desktop_pet_global_shortcut(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_config,
            open_platform_workspace,
            desktop_pet_preferences,
            update_desktop_pet_preferences,
            restore_desktop_pet_geometry,
            reset_desktop_pet_geometry,
            capture_desktop_pet_ocr,
            capture_desktop_pet_selection,
            close_desktop_pet,
            open_desktop_main_path,
            open_external_url,
            store_desktop_pet_capability,
            sync_desktop_pet_session,
            desktop_pet_active_session,
            clear_desktop_auth_token,
            desktop_pet_auth_token,
        ])
        .setup(|app| {
            configure_system_tray(app)?;
            let port = reserve_loopback_port();
            let port_argument = port.to_string();
            let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("learnflow.db");
            // Reference sources are application data, never the user's linked
            // project workspace. Keep the cache and uploaded originals in
            // separate directories so GitHub/URL sources cannot pollute a
            // project folder.
            let source_cache_dir = app_data_dir.join("repo-files");
            let source_uploads_dir = app_data_dir.join("source-uploads");
            // Keep experiment snapshots beyond PyInstaller's temporary extraction lifetime.
            let runtime_dir = app_data_dir.join("runtime");
            std::fs::create_dir_all(&runtime_dir)?;
            std::fs::create_dir_all(&source_cache_dir)?;
            std::fs::create_dir_all(&source_uploads_dir)?;
            let database_url = format!(
                "sqlite+aiosqlite:///{}",
                database_path.to_string_lossy().replace('\\', "/")
            );
            let settings_path = app_data_dir.join("settings.env");
            let plugin_artifact_dir = app_data_dir.join("plugin-artifacts");
            std::fs::create_dir_all(&plugin_artifact_dir)?;
            let pet_preferences_path = app_data_dir.join("desktop-pet-settings.json");
            let pet_preferences = load_desktop_pet_preferences(&pet_preferences_path);
            let command = app
                .shell()
                .sidecar("learnflow-backend")?
                .args(["--host", "127.0.0.1", "--port", port_argument.as_str()])
                .env("DESKTOP_MODE", "true")
                .env("DESKTOP_TOKEN", &token)
                .env("CLOUD_PLATFORM_URL", option_env!("LEARNFLOW_PLATFORM_URL").unwrap_or("https://learn.learnflow.club"))
                .env("DATABASE_URL", database_url)
                .env("SOURCE_CACHE_DIR", source_cache_dir.to_string_lossy().as_ref())
                .env("REPO_FILES_DIR", source_cache_dir.to_string_lossy().as_ref())
                .env("SOURCE_UPLOADS_DIR", source_uploads_dir.to_string_lossy().as_ref())
                .env("RUNTIME_DIR", runtime_dir.to_string_lossy().as_ref())
                .env("LEARNFLOW_SETTINGS_PATH", settings_path.to_string_lossy().as_ref())
                .env("PLUGIN_ARTIFACT_DIR", plugin_artifact_dir.to_string_lossy().as_ref())
                // A learner-visible memory graph must continuously consume
                // eligible Fact batches into versioned Module/Claim nodes.
                .env("MEMORY_AUTO_SYNTHESIS_ENABLED", "true")
                .env(
                    "CORS_ORIGINS",
                    "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:4175,http://127.0.0.1:4175",
                );
            let (_events, child) = command.spawn()?;
            app.manage(DesktopRuntimeState {
                config: DesktopRuntimeConfig {
                    api_base_url: format!("http://127.0.0.1:{port}/api"),
                    desktop_token: token,
                    cloud_origin: option_env!("LEARNFLOW_PLATFORM_URL").unwrap_or("https://learn.learnflow.club").to_string(),
                },
                sidecar: Mutex::new(Some(child)),
                pet_capability_token: Mutex::new(None),
                pet_session_id: Mutex::new(None),
                pet_preferences: Mutex::new(pet_preferences),
                pet_preferences_path,
            });
            let shortcut = app
                .state::<DesktopRuntimeState>()
                .pet_preferences
                .lock()
                .map_err(|_| "桌宠设置锁不可用")?
                .shortcut
                .clone();
            register_pet_global_shortcut(&app.handle(), &shortcut, None)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LearnFlow desktop application");

    #[cfg(target_os = "windows")]
    single_instance.start(app.handle().clone());

    app.run(|handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "pet" => {
            api.prevent_close();
            let _ = hide_desktop_pet(handle);
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(child) = handle
                .state::<DesktopRuntimeState>()
                .sidecar
                .lock()
                .expect("sidecar lock poisoned")
                .take()
            {
                let _ = child.kill();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod platform_workspace_tests {
    use super::validated_platform_url;
    #[test]
    fn validates_pinned_https_authority() {
        assert!(validated_platform_url("https://learn.example.com").is_ok());
        for url in ["http://learn.example.com", "file:///tmp/a", "https://user:pass@learn.example.com", "https://learn.example.com/?token=secret", "https://learn.example.com/#token", "https://learn.example.com/other"] {
            assert!(validated_platform_url(url).is_err(), "{url}");
        }
    }
}
