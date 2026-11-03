use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

type Reply = Result<Value, String>;
struct Pending {
    sender: tauri::async_runtime::Sender<Reply>,
    deadline: Option<Instant>,
}
#[derive(Default)]
pub struct Agent {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    stopping: AtomicBool,
}

impl Agent {
    fn enqueue(
        &self,
        window: String,
        channel: &str,
        args: Vec<Value>,
    ) -> (Value, tauri::async_runtime::Receiver<Reply>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = tauri::async_runtime::channel(1);
        self.pending.lock().unwrap().insert(
            id,
            Pending {
                sender,
                // A conversation turn and a ChatGPT sign-in (the user is in the browser) take as long
                // as they take; the agent times those out itself.
                deadline: (!["agent:run", "agent:resend", "chatgpt:sign-in"].contains(&channel))
                    .then(|| Instant::now() + Duration::from_secs(30)),
            },
        );
        (
            json!({"kind":"request","id":id,"window":window,"channel":channel,"args":args}),
            receiver,
        )
    }
    fn resolve(&self, id: u64, ok: bool, value: Option<Value>, error: Option<String>) {
        if let Some(pending) = self.pending.lock().unwrap().remove(&id) {
            let _ = pending.sender.try_send(if ok {
                Ok(value.unwrap_or(Value::Null))
            } else {
                Err(error.unwrap_or_else(|| "Agent request failed".into()))
            });
        }
    }
}

fn write(app: &tauri::AppHandle, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    app.state::<Agent>()
        .child
        .lock()
        .unwrap()
        .as_mut()
        .ok_or("Agent unavailable")?
        .write(&bytes)
        .map_err(|e| e.to_string())
}
pub fn signal(app: &tauri::AppHandle, signal: Value) {
    if let Err(e) = write(app, json!({"kind":"signal","signal":signal})) {
        eprintln!("Agent signal: {e}");
    }
}

async fn request(
    app: tauri::AppHandle,
    window: String,
    channel: String,
    args: Vec<Value>,
) -> Reply {
    let state = app.state::<Agent>();
    let (message, mut rx) = state.enqueue(window, &channel, args);
    if let Err(e) = write(&app, message.clone()) {
        state
            .pending
            .lock()
            .unwrap()
            .remove(&message["id"].as_u64().unwrap());
        return Err(e);
    }
    rx.recv()
        .await
        .unwrap_or_else(|| Err("Agent response disconnected".into()))
}
#[tauri::command]
pub async fn familiar_invoke(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Reply {
    if !["pet", "chat", "settings", "main", "panel", "quick"].contains(&window.label()) {
        return Err("Unknown window".into());
    }
    request(app, window.label().into(), channel, args).await
}
pub fn menu_request(app: &tauri::AppHandle, channel: &str, args: &[Value]) {
    let (app, channel, args) = (app.clone(), channel.to_owned(), args.to_vec());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = request(app, "tray".into(), channel, args).await {
            eprintln!("Menu request: {e}");
        }
    });
}
fn receive(app: &tauri::AppHandle, bytes: &[u8]) {
    use crate::protocol::AgentToShell;
    match serde_json::from_slice::<AgentToShell>(bytes) {
        Ok(AgentToShell::Response {
            id,
            ok,
            value,
            error,
        }) => {
            app.state::<Agent>().resolve(id, ok, value, error);
        }
        Ok(AgentToShell::Emit {
            channel,
            payload,
            target,
        }) => {
            let targets = if target == "all" {
                vec!["pet", "chat", "settings", "main", "panel", "quick"]
            } else {
                vec![target.as_str()]
            };
            for target in targets {
                if let Err(e) = app.emit_to(target, &channel, &payload) {
                    eprintln!("Agent emit: {e}");
                }
            }
        }
        Ok(AgentToShell::Ui { action }) => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = crate::windows::action(&h, action) {
                    eprintln!("Agent UI: {e}");
                }
            });
        }
        Err(e) => eprintln!("Invalid agent message: {e}"),
    }
}
fn reject(app: &tauri::AppHandle, reason: &str) {
    for (_, tx) in app.state::<Agent>().pending.lock().unwrap().drain() {
        let _ = tx.sender.try_send(Err(reason.into()));
    }
}
pub fn stop(app: &tauri::AppHandle) {
    let state = app.state::<Agent>();
    state.stopping.store(true, Ordering::Relaxed);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    reject(app, "Application exiting");
}
pub fn start(app: &tauri::AppHandle) {
    let watchdog = app.clone();
    std::thread::spawn(move || {
        while !watchdog.state::<Agent>().stopping.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(100));
            watchdog
                .state::<Agent>()
                .pending
                .lock()
                .unwrap()
                .retain(|_, pending| {
                    if pending
                        .deadline
                        .is_some_and(|deadline| Instant::now() >= deadline)
                    {
                        let _ = pending
                            .sender
                            .try_send(Err("Agent request timed out after 30s".into()));
                        false
                    } else {
                        !pending.sender.is_closed()
                    }
                });
        }
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut attempts = VecDeque::new();
        let mut failures = 0u32;
        loop {
            if app.state::<Agent>().stopping.load(Ordering::Relaxed) {
                break;
            }
            let paths = app.state::<crate::windows::Paths>();
            let command = if cfg!(debug_assertions) {
                Ok(app.shell().command("bun").arg(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent/src/main.ts"),
                ))
            } else {
                app.shell().sidecar("familiar-agent")
            };
            let spawned = command.and_then(|c| {
                c.set_process_group(true)
                    .env("FAMILIAR_DATA_DIR", &paths.data)
                    .env("FAMILIAR_RESOURCES_DIR", &paths.resources)
                    .spawn()
            });
            match spawned {
                Ok((mut events, child)) => {
                    {
                        let state = app.state::<Agent>();
                        let mut slot = state.child.lock().unwrap();
                        if state.stopping.load(Ordering::Relaxed) {
                            let _ = child.kill();
                            break;
                        }
                        *slot = Some(child);
                    }
                    let ready = app.clone();
                    let _ = app.run_on_main_thread(move || crate::windows::chat_signal(&ready));
                    let started = Instant::now();
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => receive(&app, &bytes),
                            CommandEvent::Stderr(bytes) => {
                                eprintln!("{}", String::from_utf8_lossy(&bytes))
                            }
                            CommandEvent::Error(e) => eprintln!("Agent process: {e}"),
                            CommandEvent::Terminated(status) => {
                                eprintln!("Agent exited: {status:?}");
                                break;
                            }
                            _ => {}
                        }
                    }
                    if started.elapsed() >= Duration::from_secs(60) {
                        failures = 0;
                    }
                }
                Err(e) => eprintln!("Agent startup: {e}"),
            }
            if let Some(child) = app.state::<Agent>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
            reject(&app, "Agent exited; request cancelled");
            if app.state::<Agent>().stopping.load(Ordering::Relaxed) {
                break;
            }
            let now = Instant::now();
            while attempts
                .front()
                .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
            {
                attempts.pop_front();
            }
            let mut delay = Duration::from_secs(1u64 << failures.min(5));
            failures = failures.saturating_add(1);
            if attempts.len() >= 5 {
                delay = delay.max(
                    Duration::from_secs(60)
                        .saturating_sub(now.duration_since(*attempts.front().unwrap())),
                );
            }
            tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay))
                .await
                .ok();
            attempts.push_back(Instant::now());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bun_process_round_trip_preserves_request_and_routes_response() {
        tauri::async_runtime::block_on(async {
            // No file or external service: the fake agent echoes its complete request.
            let script = r#"const line = await Bun.stdin.text(); const r=JSON.parse(line); console.log(JSON.stringify({kind:'response',id:r.id,ok:true,value:r}));"#;
            use std::io::Write;
            use std::process::{Command, Stdio};
            let mut child = Command::new("bun")
                .args(["-e", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let state = Agent::default();
            let (message, mut response) = state.enqueue(
                "settings".into(),
                "settings:get",
                vec![json!({"test":true})],
            );
            let mut bytes = serde_json::to_vec(&message).unwrap();
            bytes.push(b'\n');
            child.stdin.take().unwrap().write_all(&bytes).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            match serde_json::from_slice(&output.stdout).unwrap() {
                crate::protocol::AgentToShell::Response {
                    id,
                    ok,
                    value,
                    error,
                } => state.resolve(id, ok, value, error),
                _ => panic!("expected response"),
            }
            assert_eq!(response.recv().await.unwrap().unwrap(), message);
            assert!(state.pending.lock().unwrap().is_empty());
        });
    }
    #[test]
    fn long_running_turns_have_no_deadline_and_errors_are_routed() {
        let state = Agent::default();
        let (run, mut response) = state.enqueue("pet".into(), "agent:run", vec![]);
        let (short, _) = state.enqueue("chat".into(), "session:get", vec![]);
        // Regression: a ChatGPT sign-in failed after 30s while the user was still in the browser.
        let (sign_in, _) = state.enqueue("settings".into(), "chatgpt:sign-in", vec![]);
        let run_id = run["id"].as_u64().unwrap();
        let short_id = short["id"].as_u64().unwrap();
        let sign_in_id = sign_in["id"].as_u64().unwrap();
        // Regression: a retry showed "timed out after 30s" under a reply that took longer.
        let (resend, _) = state.enqueue("main".into(), "agent:resend", vec![]);
        let resend_id = resend["id"].as_u64().unwrap();
        assert!(state.pending.lock().unwrap()[&resend_id].deadline.is_none());
        assert!(state.pending.lock().unwrap()[&run_id].deadline.is_none());
        assert!(state.pending.lock().unwrap()[&sign_in_id]
            .deadline
            .is_none());
        assert!(state.pending.lock().unwrap()[&short_id].deadline.is_some());
        state.resolve(run_id, false, None, Some("failed".into()));
        assert_eq!(response.try_recv().unwrap(), Err("failed".into()));
    }
}
