//! Narrow URI capability. A link is only a pending ticket, never an action.
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

const EVENT: &str = "learnflow:conversion-pending";

pub fn parse_conversion_ticket(value: &str) -> Option<String> {
    let ticket = value.strip_prefix("learnflow://conversion?ticket=")?;
    if !(32..=128).contains(&ticket.len())
        || !ticket.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    Some(ticket.to_owned())
}

#[derive(Default)]
pub struct PendingConversions(Mutex<Vec<String>>);

impl PendingConversions {
    fn capture(&self, value: &str) -> bool {
        let Some(ticket) = parse_conversion_ticket(value) else { return false };
        let Ok(mut pending) = self.0.lock() else { return false };
        if !pending.contains(&ticket) && pending.len() < 8 {
            pending.push(ticket);
        }
        true
    }

    fn first(&self) -> Option<String> {
        self.0.lock().ok()?.first().cloned()
    }

    fn clear(&self, ticket: &str) {
        if let Ok(mut pending) = self.0.lock() {
            pending.retain(|entry| entry != ticket);
        }
    }
}

fn receive(app: &tauri::AppHandle, values: impl Iterator<Item = String>) {
    for value in values {
        if app.state::<PendingConversions>().capture(&value) {
            let _ = super::show_desktop_main(app);
            let _ = app.emit_to("main", EVENT, ());
        }
    }
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Register handlers before reading startup URLs to close the cold/warm race.
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        receive(&handle, event.urls().into_iter().map(|url| url.to_string()));
    });
    if let Some(urls) = app.deep_link().get_current()? {
        receive(app, urls.into_iter().map(|url| url.to_string()));
    }
    // macOS receives links through the installed bundle's CFBundleURLTypes.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    app.deep_link().register_all()?;
    Ok(())
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("请在主窗口导入项目".into()); }
    Ok(())
}

#[tauri::command]
pub fn desktop_pending_conversion(window: WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    Ok(window.state::<PendingConversions>().first())
}

#[tauri::command]
pub fn clear_desktop_pending_conversion(window: WebviewWindow, ticket: String) -> Result<(), String> {
    require_main(&window)?;
    window.state::<PendingConversions>().clear(&ticket);
    window.emit(EVENT, ()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn choose_conversion_parent(window: WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        window.dialog().file().set_title("选择新项目所在的父目录")
            .blocking_pick_folder()
            .map(|path| path.into_path().map(|value| value.to_string_lossy().into_owned())
                .map_err(|_| "所选路径必须是本机目录".to_owned()))
            .transpose()
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const TICKET: &str = "abcdefghijklmnopqrstuvwxyz0123456789AB_-";
    #[test]
    fn rejects_urls_outside_the_single_ticket_protocol() {
        assert_eq!(parse_conversion_ticket(&format!("learnflow://conversion?ticket={TICKET}")), Some(TICKET.into()));
        for url in [
            format!("https://conversion?ticket={TICKET}"),
            format!("learnflow://other?ticket={TICKET}"),
            format!("learnflow://user@conversion?ticket={TICKET}"),
            format!("learnflow://conversion:80?ticket={TICKET}"),
            format!("learnflow://conversion/path?ticket={TICKET}"),
            format!("learnflow://conversion?ticket={TICKET}&ticket={TICKET}"),
            format!("learnflow://conversion?ticket={TICKET}&redirect=https://example.com"),
            format!("learnflow://conversion?ticket={TICKET}#fragment"),
            "learnflow://conversion?ticket=%61abcdefghijklmnopqrstuvwxyz012345".into(),
            "learnflow://conversion?ticket=short".into(),
        ] { assert!(parse_conversion_ticket(&url).is_none(), "accepted {url}"); }
    }
    #[test]
    fn startup_and_warm_links_wait_for_login_without_duplicate_consumption() {
        let pending = PendingConversions::default();
        let link = format!("learnflow://conversion?ticket={TICKET}");
        assert!(pending.capture(&link)); // cold launch before webview/login
        assert!(pending.capture(&link)); // warm dispatch while login is visible
        assert_eq!(pending.first(), Some(TICKET.into()));
        pending.clear("another-ticket");
        assert_eq!(pending.first(), Some(TICKET.into())); // no implicit login/preview consume
        pending.clear(TICKET);
        assert_eq!(pending.first(), None);
        assert!(pending.capture(&link)); // retry/reopen can restore same formal project
    }
}
