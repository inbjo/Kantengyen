use crate::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use tokio::sync::mpsc;

pub struct VoiceSeat {
    connection: String,
    muted: bool,
    sender: mpsc::Sender<Value>,
}

#[derive(Default)]
pub struct VoiceConfig {
    servers: Vec<Value>,
    turn_urls: Vec<String>,
    secret: Option<String>,
    relay_only: bool,
}
impl VoiceConfig {
    pub fn from_env() -> Result<Self, String> {
        let servers: Vec<Value> = serde_json::from_str(
            &std::env::var("VOICE_ICE_SERVERS").unwrap_or_else(|_| "[]".into()),
        )
        .map_err(|_| "VOICE_ICE_SERVERS 必须是 ICE server JSON 数组")?;
        if servers.len() > 8 {
            return Err("ICE server 数量超过上限".into());
        }
        for server in &servers {
            let urls = match &server["urls"] {
                Value::String(url) => vec![url.as_str()],
                Value::Array(urls) => urls
                    .iter()
                    .map(|url| url.as_str().ok_or("ICE URL 必须是字符串"))
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err("ICE server 缺少 urls".into()),
            };
            if urls.is_empty()
                || urls.iter().any(|url| {
                    !["stun:", "stuns:", "turn:", "turns:"]
                        .iter()
                        .any(|prefix| url.starts_with(prefix))
                })
            {
                return Err("ICE URL 协议无效".into());
            }
            if urls.iter().any(|url| url.starts_with("turn"))
                && (!server["username"].is_string() || !server["credential"].is_string())
            {
                return Err("静态 TURN 配置必须提供 username 和 credential".into());
            }
        }
        let turn_urls: Vec<String> = std::env::var("VOICE_TURN_URLS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        if turn_urls
            .iter()
            .any(|url| !url.starts_with("turn:") && !url.starts_with("turns:"))
        {
            return Err("VOICE_TURN_URLS 仅支持 turn/turns URL".into());
        }
        let secret = std::env::var("VOICE_TURN_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        if secret.is_some() == turn_urls.is_empty() {
            return Err("VOICE_TURN_URLS 与 VOICE_TURN_SECRET 必须同时配置".into());
        }
        let relay_only = match std::env::var("VOICE_ICE_POLICY")
            .unwrap_or_else(|_| "all".into())
            .as_str()
        {
            "all" => false,
            "relay" => true,
            _ => return Err("VOICE_ICE_POLICY 必须为 all 或 relay".into()),
        };
        let config = Self {
            servers,
            turn_urls,
            secret,
            relay_only,
        };
        if relay_only && !config.has_relay() {
            return Err("relay 模式必须配置 TURN".into());
        }
        Ok(config)
    }
    fn has_relay(&self) -> bool {
        !self.turn_urls.is_empty()
            || self.servers.iter().any(|s| {
                s["urls"].to_string().contains("turn:") || s["urls"].to_string().contains("turns:")
            })
    }
    fn configuration(&self, id: &str, now: u64) -> Value {
        let mut servers = self.servers.clone();
        if let Some(secret) = &self.secret {
            let username = format!("{}:{id}", now + 3600);
            let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
                .expect("HMAC accepts any key length");
            mac.update(username.as_bytes());
            let credential = STANDARD.encode(mac.finalize().into_bytes());
            servers
                .push(json!({"urls":self.turn_urls,"username":username,"credential":credential}));
        }
        json!({"iceServers":servers,"iceTransportPolicy":if self.relay_only {"relay"} else {"all"}})
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command {
    Signal {
        target: String,
        target_session: Option<String>,
        data: Value,
    },
    Mute {
        muted: bool,
    },
    Ping,
}
fn valid_signal(data: &Value) -> bool {
    let Some(object) = data.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    if data.get("restart") == Some(&Value::Bool(true)) {
        return true;
    }
    if let Some(description) = data.get("description") {
        return matches!(description["type"].as_str(), Some("offer" | "answer"))
            && description["sdp"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 24_000
                    && !s
                        .lines()
                        .any(|line| line.starts_with("m=") && !line.starts_with("m=audio "))
            });
    }
    data.get("candidate").is_some_and(|candidate| {
        candidate["candidate"]
            .as_str()
            .is_some_and(|s| s.len() <= 2048)
    })
}
fn members(room: &Room) -> Vec<Value> {
    room.players
        .iter()
        .filter_map(|p| {
            p.voice.as_ref().map(|v| {
                json!({
                "id":p.profile.id,"name":p.profile.name,"muted":v.muted,"session":v.connection,
                })
            })
        })
        .collect()
}
fn announce(room: &Room) {
    let message = json!({"type":"members","members":members(room)});
    for player in &room.players {
        if let Some(voice) = &player.voice {
            let _ = voice.sender.try_send(message.clone());
        }
    }
}
fn active(room: &Room, id: &str, connection: &str) -> bool {
    !room.ended
        && !room.practice
        && room.players.iter().any(|p| {
            p.profile.id == id
                && p.connection.is_some()
                && p.voice.as_ref().is_some_and(|v| v.connection == connection)
        })
}
fn process(
    room: &mut Room,
    id: &str,
    connection: &str,
    command: Command,
) -> Result<(), &'static str> {
    if !active(room, id, connection) {
        return Err("语音已结束或身份已被其他页面使用");
    }
    match command {
        Command::Signal {
            target,
            target_session,
            data,
        } => {
            if target == id || !valid_signal(&data) {
                return Err("无效语音信令");
            }
            let target = room
                .players
                .iter()
                .find(|p| p.profile.id == target && p.connection.is_some())
                .and_then(|p| p.voice.as_ref())
                .ok_or("对方尚未开启语音或已经离开")?;
            if target_session
                .as_ref()
                .is_some_and(|session| session != &target.connection)
            {
                return Err("对方已重新加入语音，旧信令已忽略");
            }
            target
                .sender
                .try_send(json!({"type":"signal","from":id,"from_session":connection,"data":data}))
                .map_err(|_| "对方语音连接繁忙，请重新开启语音")?;
        }
        Command::Mute { muted } => {
            room.players
                .iter_mut()
                .find(|p| p.profile.id == id)
                .unwrap()
                .voice
                .as_mut()
                .unwrap()
                .muted = muted;
            announce(room);
        }
        Command::Ping => {
            let voice = room
                .players
                .iter()
                .find(|p| p.profile.id == id)
                .unwrap()
                .voice
                .as_ref()
                .unwrap();
            let _ = voice.sender.try_send(json!({"type":"pong"}));
        }
    }
    room.touched = Instant::now();
    Ok(())
}
pub async fn upgrade(State(state): State<Shared>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(32_768)
        .max_frame_size(32_768)
        .on_upgrade(move |socket| connection(state, socket))
}
async fn closed(socket: &mut WebSocket, error: &str) {
    let _ = socket
        .send(Message::Text(
            json!({"type":"closed","error":error}).to_string().into(),
        ))
        .await;
}
async fn connection(state: Shared, mut socket: WebSocket) {
    let auth = match tokio::time::timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<AuthMessage>(&text).ok(),
        _ => None,
    };
    let Some(auth) = auth else {
        closed(&mut socket, "无效身份").await;
        return;
    };
    let profile = state
        .sessions
        .read()
        .await
        .get(&auth.token)
        .map(|s| s.profile.clone());
    let room = state.rooms.read().await.get(&auth.code).cloned();
    let (Some(profile), Some(room)) = (profile, room) else {
        closed(&mut socket, "身份或房间已过期").await;
        return;
    };
    let connection = Uuid::new_v4().to_string();
    let (sender, mut outgoing) = mpsc::channel(128);
    let mut events = {
        let mut room = room.lock().await;
        if room.ended
            || room.practice
            || !room
                .players
                .iter()
                .any(|p| p.profile.id == profile.id && p.connection.is_some())
        {
            drop(room);
            closed(&mut socket, "请先进入正常房间，结束的房间不能开启语音").await;
            return;
        }
        let player = room
            .players
            .iter_mut()
            .find(|p| p.profile.id == profile.id)
            .unwrap();
        if let Some(previous) = player.voice.take() {
            let _ = previous
                .sender
                .try_send(json!({"type":"closed","error":"这个身份已在另一页开启语音"}));
        }
        player.voice = Some(VoiceSeat {
            connection: connection.clone(),
            muted: false,
            sender: sender.clone(),
        });
        let _ = sender.try_send(json!({"type":"welcome","id":profile.id,"configuration":state.voice_config.configuration(&profile.id,now_ms()/1000),"has_relay":state.voice_config.has_relay(),"members":members(&room)}));
        announce(&room);
        room.changed.subscribe()
    };
    let (mut tx, mut rx) = socket.split();
    let mut recent = Vec::new();
    let mut last_input = Instant::now();
    let mut maintenance = tokio::time::interval(Duration::from_secs(10));
    let mut configured = Instant::now();
    loop {
        tokio::select! {
            message = outgoing.recv() => {
                let Some(message) = message else { break; };
                let terminal = message["type"] == "closed";
                if tx.send(Message::Text(message.to_string().into())).await.is_err() || terminal { break; }
            }
            _ = events.recv() => {
                if !active(&*room.lock().await, &profile.id, &connection) {
                    let _=tx.send(Message::Text(json!({"type":"closed","error":"已离开房间或游戏已结束，语音已关闭"}).to_string().into())).await; break;
                }
            }
            _ = maintenance.tick() => {
                if last_input.elapsed() > Duration::from_secs(60) { break; }
                if configured.elapsed() > Duration::from_secs(1200) {
                    configured = Instant::now();
                    let _=sender.try_send(json!({"type":"config","configuration":state.voice_config.configuration(&profile.id,now_ms()/1000)}));
                }
            }
            incoming = rx.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { break; };
                last_input = Instant::now();
                recent.retain(|t: &Instant| t.elapsed() < Duration::from_secs(1));
                if recent.len() >= 100 { break; }
                recent.push(Instant::now());
                let response = match serde_json::from_str::<Command>(&text) {
                    Ok(cmd) => process(&mut *room.lock().await, &profile.id, &connection, cmd).err(),
                    Err(_) => Some("无法识别语音操作"),
                };
                if let Some(error) = response {
                    if tx.send(Message::Text(json!({"type":"error","error":error}).to_string().into())).await.is_err() { break; }
                } else if let Some(session) = state.sessions.write().await.get_mut(&auth.token) { session.touched = Instant::now(); }
            }
        }
    }
    let mut room = room.lock().await;
    if let Some(player) = room.players.iter_mut().find(|p| p.profile.id == profile.id)
        && player
            .voice
            .as_ref()
            .is_some_and(|v| v.connection == connection)
    {
        player.voice = None;
        announce(&room);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn turn_credentials_never_expose_shared_secret() {
        let config = VoiceConfig {
            servers: vec![],
            turn_urls: vec!["turn:turn.example.com:3478".into()],
            secret: Some("private-secret".into()),
            relay_only: true,
        };
        let rtc = config.configuration("player", 100);
        assert_eq!(rtc["iceServers"][0]["username"], "3700:player");
        assert!(!rtc.to_string().contains("private-secret"));
        let mut mac = Hmac::<Sha1>::new_from_slice(b"private-secret").unwrap();
        mac.update(b"3700:player");
        assert_eq!(
            rtc["iceServers"][0]["credential"],
            STANDARD.encode(mac.finalize().into_bytes())
        );
    }
    #[test]
    fn signal_payloads_are_bounded_and_typed() {
        assert!(valid_signal(
            &json!({"description":{"type":"offer","sdp":"v=0"}})
        ));
        assert!(valid_signal(
            &json!({"candidate":{"candidate":"candidate:local"}})
        ));
        assert!(!valid_signal(
            &json!({"description":{"type":"rollback","sdp":"v=0"}})
        ));
        assert!(!valid_signal(
            &json!({"description":{"type":"offer","sdp":"v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"}})
        ));
        assert!(!valid_signal(
            &json!({"candidate":{"candidate":"x".repeat(2049)}})
        ));
        assert!(!valid_signal(
            &json!({"description":{"type":"offer","sdp":"v=0"},"candidate":{}})
        ));
    }
}
