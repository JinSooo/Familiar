//! NDJSON wire messages and the read-only pet asset and conversation file protocols.
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tauri::http::{Response, StatusCode};

#[derive(Debug)]
pub enum AgentToShell {
    Response {
        id: u64,
        ok: bool,
        value: Option<Value>,
        error: Option<String>,
    },
    Emit {
        channel: String,
        payload: Value,
        target: String,
    },
    Ui {
        action: UiAction,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UiAction {
    ShowChat,
    HideChat,
    /// The quick-ask bar: a centered panel with its own field.
    ShowQuick,
    HideQuick,
    /// Make the pet panel key so the capsule receives typing and its own blur.
    FocusPet,
    ShowSettings,
    /// The standalone conversation window; Familiar shows in the Dock while it is open.
    ShowMain,
    Shortcuts {
        bindings: std::collections::HashMap<String, String>,
    },
    PetVisible {
        visible: bool,
    },
    PetSize {
        width: f64,
        height: f64,
    },
    Tray {
        pets: Vec<PetEntry>,
        #[serde(rename = "currentPet")]
        current_pet: String,
        size: String,
        /// "off" | "on" | "paused": whether the tray offers to pause Computer History.
        #[serde(default)]
        perception: String,
    },
    /// How opaque the chat panel and the menu bar panel windows are (0.5 to 1).
    PanelOpacity {
        value: f64,
        /// The settings and big conversation windows.
        windows: f64,
    },
    Quit,
}

#[derive(Debug, Deserialize)]
pub struct PetEntry {
    pub id: String,
    pub name: String,
}

impl<'de> Deserialize<'de> for AgentToShell {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        enum Wire {
            Response {
                id: u64,
                ok: bool,
                value: Option<Value>,
                error: Option<String>,
            },
            Emit {
                channel: String,
                payload: Value,
                target: String,
            },
            Ui {
                action: UiAction,
            },
        }
        let message = Wire::deserialize(deserializer)?;
        match message {
            Wire::Response {
                id,
                ok,
                value,
                error,
            } => {
                if !ok && error.is_none() {
                    return Err(serde::de::Error::custom("failed response requires error"));
                }
                Ok(Self::Response {
                    id,
                    ok,
                    value,
                    error,
                })
            }
            Wire::Emit {
                channel,
                payload,
                target,
            } => {
                if !matches!(
                    target.as_str(),
                    "pet" | "chat" | "settings" | "main" | "panel" | "quick" | "all"
                ) {
                    return Err(serde::de::Error::custom("invalid event target"));
                }
                Ok(Self::Emit {
                    channel,
                    payload,
                    target,
                })
            }
            Wire::Ui { action } => {
                if let UiAction::Tray { size, .. } = &action {
                    if !matches!(size.as_str(), "small" | "medium" | "large" | "custom") {
                        return Err(serde::de::Error::custom("invalid pet size"));
                    }
                }
                Ok(Self::Ui { action })
            }
        }
    }
}

// Decode once, then reject encoded separators and a remaining percent sign. This
// also rejects double-encoded traversal rather than relying on URL normalization.
fn asset_path(uri: &str) -> Result<PathBuf, ()> {
    scheme_path(uri, "familiar-pet://localhost/")
}

fn scheme_path(uri: &str, prefix: &str) -> Result<PathBuf, ()> {
    let path = uri.strip_prefix(prefix).ok_or(())?;
    let path = path.split(['?', '#']).next().ok_or(())?;
    let mut decoded = Vec::new();
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = path.get(i + 1..i + 3).ok_or(())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            if matches!(byte, b'/' | b'\\' | b'%' | 0) {
                return Err(());
            }
            decoded.push(byte);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let path = String::from_utf8(decoded).map_err(|_| ())?;
    if path.contains(['\\', '\0', ':'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(());
    }
    let path = PathBuf::from(path);
    if path.components().count() < 2
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(());
    }
    Ok(path)
}

fn confined_file(root: &Path, relative: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    // Confine each asset to its own pet directory as well as the pets root.
    let id = relative.components().next()?;
    let pet = root.join(id.as_os_str()).canonicalize().ok()?;
    if !pet.starts_with(&root) {
        return None;
    }
    let file = root.join(relative).canonicalize().ok()?;
    (file.starts_with(&pet) && file.is_file()).then_some(file)
}

pub fn serve(resources: &Path, data: &Path, uri: &str) -> Response<Vec<u8>> {
    let relative = match asset_path(uri) {
        Ok(path) => path,
        Err(()) => {
            return reply(
                StatusCode::BAD_REQUEST,
                "text/plain",
                b"Invalid asset path".to_vec(),
            )
        }
    };
    // A bundled id owns its entire namespace; missing bundled files must not
    // fall back to an unrelated user-installed pet with the same id.
    let id = relative.components().next().expect("validated pet id");
    let bundled = resources.join("pets");
    let root = if bundled.join(id.as_os_str()).symlink_metadata().is_ok() {
        bundled
    } else {
        data.join("pets")
    };
    let Some(file) = confined_file(&root, &relative) else {
        return reply(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"Asset not found".to_vec(),
        );
    };
    let mime = match file.extension().and_then(|ext| ext.to_str()) {
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    match std::fs::read(file) {
        Ok(bytes) => reply(StatusCode::OK, mime, bytes),
        Err(_) => reply(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"Asset not found".to_vec(),
        ),
    }
}

/// Files kept with conversations (`<data>/conversations/files/<conversation id>/<name>`): what the
/// user sent and generated images. Read-only, one conversation folder deep, no symlinks out.
pub fn serve_file(data: &Path, uri: &str) -> Response<Vec<u8>> {
    let not_found = || {
        reply(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"File not found".to_vec(),
        )
    };
    let Ok(relative) = scheme_path(uri, "familiar-file://localhost/") else {
        return reply(
            StatusCode::BAD_REQUEST,
            "text/plain",
            b"Invalid file path".to_vec(),
        );
    };
    if relative.components().count() != 2 {
        return not_found();
    }
    let Some(file) = confined_file(&data.join("conversations/files"), &relative) else {
        return not_found();
    };
    let mime = match file
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    match std::fs::read(file) {
        Ok(bytes) => reply(StatusCode::OK, mime, bytes),
        Err(_) => not_found(),
    }
}

fn reply(status: StatusCode, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .expect("static HTTP headers")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_paths_reject_traversal_and_encoded_bypasses() {
        assert_eq!(
            asset_path("familiar-pet://localhost/cat/sprite.webp").unwrap(),
            PathBuf::from("cat/sprite.webp")
        );
        for path in [
            "../secret",
            "cat/../secret",
            "cat/%2e%2e/secret",
            "cat/%252e%252e/secret",
            "cat/%2fetc",
            "/etc/passwd",
            "cat/\\secret",
            "cat/%00",
            "cat//file",
            "cat/%zz",
        ] {
            assert!(
                asset_path(&format!("familiar-pet://localhost/{path}")).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn parses_wire_contract_and_rejects_invalid_messages() {
        for line in [
            r#"{"kind":"response","id":1,"ok":true,"value":null}"#,
            r#"{"kind":"response","id":2,"ok":false,"error":"failed"}"#,
            r#"{"kind":"emit","channel":"pet:state","payload":{},"target":"all"}"#,
            // Regression: events for the menu bar panel were rejected as an invalid target.
            r#"{"kind":"emit","channel":"pet:state","payload":{},"target":"panel"}"#,
            r#"{"kind":"ui","action":{"type":"tray","pets":[{"id":"cat","name":"Cat"}],"currentPet":"cat","size":"small"}}"#,
            r#"{"kind":"ui","action":{"type":"tray","pets":[],"currentPet":"","size":"custom"}}"#,
            r#"{"kind":"ui","action":{"type":"pet-size","width":460,"height":400}}"#,
        ] {
            assert!(serde_json::from_str::<AgentToShell>(line).is_ok(), "{line}");
        }
        for line in [
            r#"{"kind":"response","id":2,"ok":false}"#,
            r#"{"kind":"emit","channel":"x","payload":{},"target":"unknown"}"#,
            r#"{"kind":"ui","action":{"type":"tray","pets":[],"currentPet":"cat","size":"huge"}}"#,
        ] {
            assert!(serde_json::from_str::<AgentToShell>(line).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_preserves_bundled_precedence() {
        let temp = std::env::temp_dir().join(format!("familiar-protocol-{}", std::process::id()));
        let resources = temp.join("resources");
        let data = temp.join("data");
        std::fs::create_dir_all(resources.join("pets/cat")).unwrap();
        std::fs::create_dir_all(data.join("pets/cat")).unwrap();
        std::fs::write(temp.join("secret.png"), b"secret").unwrap();
        std::fs::write(data.join("pets/cat/only.png"), b"user").unwrap();
        std::os::unix::fs::symlink(
            temp.join("secret.png"),
            resources.join("pets/cat/escape.png"),
        )
        .unwrap();
        assert_eq!(
            serve(&resources, &data, "familiar-pet://localhost/cat/escape.png").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(&resources, &data, "familiar-pet://localhost/cat/only.png").status(),
            StatusCode::NOT_FOUND
        );
        std::fs::write(resources.join("pets/cat/ok.png"), b"png").unwrap();
        let response = serve(&resources, &data, "familiar-pet://localhost/cat/ok.png");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["Access-Control-Allow-Origin"], "*");
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn conversation_files_stay_inside_their_folder() {
        let temp = std::env::temp_dir().join(format!("familiar-files-{}", std::process::id()));
        let files = temp.join("conversations/files/2026-11-01-1200-abcd");
        std::fs::create_dir_all(&files).unwrap();
        std::fs::write(temp.join("settings.json"), b"secret").unwrap();
        std::fs::write(files.join("cat.png"), b"png").unwrap();
        std::os::unix::fs::symlink(temp.join("settings.json"), files.join("escape.png")).unwrap();
        let get = |path: &str| serve_file(&temp, &format!("familiar-file://localhost/{path}"));
        let ok = get("2026-11-01-1200-abcd/cat.png");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["Content-Type"], "image/png");
        for path in [
            "2026-11-01-1200-abcd/escape.png",
            "2026-11-01-1200-abcd/%2e%2e/%2e%2e/settings.json",
            "../settings.json",
            "settings.json",
            "2026-11-01-1200-abcd/missing.png",
        ] {
            assert_ne!(get(path).status(), StatusCode::OK, "{path}");
        }
        std::fs::remove_dir_all(temp).unwrap();
    }
}
