use axum::{
    Json, Router,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use kantengyen_core::{Card, DECK_SIZE, Game, legal_moves};
use rand::{Rng, seq::SliceRandom};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock, broadcast};
mod assets;
mod embedded_turn;
mod persistence;
mod voice;
use uuid::Uuid;

type Shared = Arc<AppState>;
type RoomRef = Arc<Mutex<Room>>;
type ApiError = (StatusCode, Json<Value>);
fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({ "error": message })))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
struct Profile {
    id: String,
    name: String,
    avatar_seed: String,
}
struct Session {
    profile: Profile,
    touched: Instant,
}
#[derive(Default)]
struct AppState {
    store: persistence::Store,
    storage_error: std::sync::atomic::AtomicBool,
    stopping: std::sync::atomic::AtomicBool,
    shutdown: tokio::sync::Notify,
    voice_config: voice::VoiceConfig,
    sessions: RwLock<HashMap<String, Session>>,
    rooms: RwLock<HashMap<String, RoomRef>>,
    // Creation/join serialize membership changes to prevent joining two rooms concurrently.
    membership: Mutex<HashMap<String, String>>,
    rate: Mutex<HashMap<String, Vec<Instant>>>,
}
#[derive(Serialize, Deserialize)]
struct Player {
    profile: Profile,
    bot: bool,
    ready: bool,
    #[serde(skip)]
    connection: Option<String>,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    pending: bool,
    score: i64,
    #[serde(skip)]
    voice: Option<voice::VoiceSeat>,
}
fn room_events() -> broadcast::Sender<()> {
    broadcast::channel(32).0
}
#[derive(Serialize, Deserialize)]
struct Room {
    code: String,
    practice: bool,
    host: String,
    players: Vec<Player>,
    game: Option<Game>,
    round: u32,
    completed_rounds: u32,
    round_limit: Option<u32>,
    ended: bool,
    abandoned_round: bool,
    final_scores: Vec<Value>,
    #[serde(default)]
    last_settlement: Option<Value>,
    #[serde(default)]
    bot_target: usize,
    #[serde(default)]
    retired_players: Vec<Player>,
    version: u64,
    #[serde(skip, default = "room_events")]
    changed: broadcast::Sender<()>,
    #[serde(skip, default = "Instant::now")]
    touched: Instant,
    #[serde(skip, default = "Instant::now")]
    deadline: Instant,
    deadline_ms: u64,
    seen: HashSet<String>,
    history: Vec<String>,
}
impl Room {
    fn apply_bots(&mut self) {
        let humans = self.players.iter().filter(|p| !p.bot).count();
        self.bot_target = self.bot_target.min(8 - humans);
        let mut count = self.players.iter().filter(|p| p.bot).count();
        while count > self.bot_target {
            let index = self.players.iter().rposition(|p| p.bot).unwrap();
            let player = self.players.remove(index);
            if player.score != 0 {
                self.retired_players.push(player);
            }
            count -= 1;
        }
        while count < self.bot_target {
            let id = Uuid::new_v4().to_string();
            self.players.push(Player {
                profile: Profile {
                    id: id.clone(),
                    name: format!("机器人 {}", count + 1),
                    avatar_seed: id,
                },
                bot: true,
                ready: true,
                connection: None,
                managed: false,
                pending: false,
                score: 0,
                voice: None,
            });
            count += 1;
        }
    }
    fn settlement(&self) -> Value {
        let Some(game) = &self.game else {
            return Value::Null;
        };
        json!({"round":self.round,"multiplier":game.multiplier,"winner":game.winner,
            "entries":self.players.iter().take(game.hands.len()).enumerate().map(|(i,p)| json!({
                "id":p.profile.id,"name":p.profile.name,"remaining":game.hands[i].len(),
                "delta":game.result[i],"contribution":if game.result[i]<0 {-game.result[i]} else {0}
            })).collect::<Vec<_>>()})
    }
    fn update(&mut self) {
        let millis = if self
            .game
            .as_ref()
            .is_some_and(|g| self.is_automated(g.turn))
        {
            900
        } else {
            30_000
        };
        self.deadline = Instant::now() + Duration::from_millis(millis);
        self.deadline_ms = now_ms() + millis;
        self.publish();
    }
    fn is_automated(&self, seat: usize) -> bool {
        self.players[seat].bot
            || self.players[seat].managed
            || self.players[seat].connection.is_none()
    }
    fn connection_changed(&mut self, seat: usize) {
        if !self.practice && !self.players[seat].bot && self.players[seat].connection.is_none() {
            self.players[seat].managed = true;
        }
        if self
            .game
            .as_ref()
            .is_some_and(|g| g.winner.is_none() && g.turn == seat)
        {
            self.update();
        } else {
            self.publish();
        }
    }
    fn publish(&mut self) {
        self.version += 1;
        self.touched = Instant::now();
        let _ = self.changed.send(());
    }
    fn begin(&mut self) {
        if !self.practice {
            self.apply_bots();
        }
        for player in &mut self.players {
            player.pending = false;
        }
        self.round += 1;
        let dealer = if self.practice {
            0
        } else {
            (self.round as usize - 1) % self.players.len()
        };
        let mut deck: Vec<Card> = (0..DECK_SIZE).collect();
        deck.shuffle(&mut rand::rng());
        let mut game = Game::deal(deck, self.players.len(), dealer);
        if self.practice {
            // Three reproducible lessons; bots use the same legal-move generator as normal play.
            let hands = match (self.round - 1) % 3 {
                0 => vec![
                    vec![0, 2, 15, 8, 12, 52],
                    vec![1, 4, 17, 9, 23],
                    vec![3, 5, 18, 10, 24],
                ],
                1 => vec![
                    vec![0, 1, 2, 7, 20, 53],
                    vec![14, 15, 16, 8, 21],
                    vec![28, 29, 30, 9, 22],
                ],
                _ => vec![
                    vec![3, 16, 29, 6, 19, 52],
                    vec![4, 17, 30, 7, 20],
                    vec![5, 18, 31, 8, 21],
                ],
            };
            let used: HashSet<_> = hands.iter().flatten().copied().collect();
            game.hands = hands;
            // Keep lessons brief: only eight additional cards participate in each exercise.
            // Multiplayer still deals and plays the full 54-card deck.
            game.deck = (0..DECK_SIZE)
                .filter(|c| !used.contains(c))
                .take(8)
                .collect();
            game.deck.reverse();
            game.message = match (self.round - 1) % 3 {
                0 => "第一课：单张接大一级，2 可以接任意较小单张；试试提示",
                1 => "第二课：至少三张连续牌组成顺子，2 不能进入顺子",
                _ => "第三课：三张同点数是炸弹，大小王是万能牌，可以配牌但不能单出",
            }
            .into();
        }
        self.game = Some(game);
        self.history.clear();
        self.update();
    }
    fn settle(&mut self) {
        if let Some(game) = &self.game
            && game.winner.is_some()
            && self.completed_rounds < self.round
        {
            for (player, delta) in self.players.iter_mut().zip(&game.result) {
                player.score += delta;
            }
            self.completed_rounds += 1;
            self.last_settlement = Some(self.settlement());
            if !self.practice
                && self
                    .round_limit
                    .is_some_and(|limit| self.completed_rounds >= limit)
            {
                self.finish("已达到设定局数，房间已解散");
            }
        }
    }
    fn finish(&mut self, reason: &str) {
        self.abandoned_round = self.game.as_ref().is_some_and(|g| g.winner.is_none());
        let mut players: Vec<_> = self.players.iter().chain(&self.retired_players).collect();
        players.sort_by_key(|p| std::cmp::Reverse(p.score));
        let mut rank = 0;
        let mut previous_score = None;
        self.final_scores = players.iter().enumerate().map(|(i, p)| {
            if previous_score != Some(p.score) { rank = i + 1; }
            previous_score = Some(p.score);
            json!({"id":p.profile.id,"name":p.profile.name,"avatar_seed":p.profile.avatar_seed,"score":p.score,"rank":rank})
        }).collect();
        self.game = None;
        self.ended = true;
        self.add_history(reason.into());
    }
    fn add_history(&mut self, text: String) {
        self.history.push(text);
        if self.history.len() > 8 {
            self.history.remove(0);
        }
    }
    fn advance_timeout(&mut self) {
        let Some(game) = &self.game else {
            return;
        };
        if game.winner.is_some() {
            return;
        }
        let seat = game.turn;
        if Instant::now() < self.deadline || (self.practice && !self.players[seat].bot) {
            return;
        }
        let moves = legal_moves(&game.hands[seat], game.last.as_ref().map(|p| &p.pattern));
        let has_last = game.last.is_some();
        let bot = self.is_automated(seat);
        let game = self.game.as_mut().unwrap();
        let action = if !bot && has_last {
            game.pass(seat)
        } else if let Some(cards) = moves.into_iter().next() {
            game.play(seat, cards)
        } else if has_last {
            game.pass(seat)
        } else {
            while game.hands[seat].iter().all(|&c| c >= 52) && !game.deck.is_empty() {
                game.hands[seat].push(game.deck.pop().unwrap());
            }
            if let Some(cards) = legal_moves(&game.hands[seat], None).into_iter().next() {
                game.play(seat, cards)
            } else {
                game.draw();
                Ok(())
            }
        };
        if action.is_ok() {
            let name = self.players[seat].profile.name.clone();
            self.add_history(format!(
                "{name}{}",
                if bot {
                    " 由机器代打完成了操作"
                } else {
                    " 超时，系统已代操作"
                }
            ));
            self.settle();
            self.update();
        }
    }
    fn snapshot(&self, id: &str) -> Value {
        let seat = self
            .players
            .iter()
            .position(|p| p.profile.id == id)
            .unwrap();
        let phase = match &self.game {
            _ if self.ended => "ended",
            None => "waiting",
            Some(g) if g.winner.is_some() => "finished",
            _ => "playing",
        };
        json!({
            "type": "snapshot", "code": self.code, "practice": self.practice,
            "host": self.host, "seat": seat, "round": self.round, "version": self.version,
            "phase": phase, "deadline_ms": if self.practice { 0 } else { self.deadline_ms },
            "completed_rounds": self.completed_rounds, "abandoned_round": self.abandoned_round,
            "round_limit": self.round_limit,
            "final_scores": self.final_scores,
            "bot_target": self.bot_target,
            "retired_scores": self.retired_players.iter().map(|p| json!({"id":p.profile.id,"name":p.profile.name,"score":p.score})).collect::<Vec<_>>(),
            "players": self.players.iter().enumerate().map(|(i,p)| json!({
                "id": p.profile.id, "name": p.profile.name, "avatar_seed": p.profile.avatar_seed,
                "bot": p.bot, "ready": p.ready, "online": p.bot || p.connection.is_some(), "score": p.score,
                "managed": !self.practice && p.managed,
                "pending": p.pending,
                "auto_play": !p.pending && !self.practice && !p.bot && (p.managed || p.connection.is_none()) && phase == "playing",
                "count": self.game.as_ref().and_then(|g| g.hands.get(i)).map(Vec::len).unwrap_or(0)
            })).collect::<Vec<_>>(),
            "hand": self.game.as_ref().and_then(|g| g.hands.get(seat)),
            "turn": self.game.as_ref().map(|g| g.turn),
            "last": self.game.as_ref().and_then(|g| g.last.as_ref()),
            "auto_pass_available": self.game.as_ref().is_some_and(|g|
                g.winner.is_none() && g.turn == seat && g.last.is_some()
                && legal_moves(&g.hands[seat], g.last.as_ref().map(|p| &p.pattern)).is_empty()),
            "deck_count": self.game.as_ref().map(|g| g.deck.len()).unwrap_or(DECK_SIZE as usize),
            "multiplier": self.game.as_ref().map(|g| g.multiplier).unwrap_or(1),
            "winner": self.game.as_ref().and_then(|g| g.winner).map(|w| if w == usize::MAX { -1 } else { w as i64 }),
            "result": self.game.as_ref().map(|g| &g.result),
            "message": self.game.as_ref().map(|g| g.message.as_str()).unwrap_or("等朋友入座，准备好就开局"),
            "history": self.history,
            "settlement": if phase == "finished" { Some(self.settlement()) } else { self.last_settlement.clone() },
        })
    }
}

#[derive(Deserialize)]
struct SessionInput {
    token: Option<String>,
    name: String,
    avatar_seed: String,
}
async fn session(
    State(state): State<Shared>,
    Json(input): Json<SessionInput>,
) -> Result<Json<Value>, ApiError> {
    let name = input.name.trim();
    if name.is_empty()
        || name.chars().count() > 16
        || name.chars().any(char::is_control)
        || input.avatar_seed.len() > 128
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "名字需要 1–16 个字符，头像种子不能超过 128 字节",
        ));
    }
    let mut sessions = state.sessions.write().await;
    if sessions.len() >= 20_000 {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "暂时无法创建新身份，请稍后再试",
        ));
    }
    let token = input
        .token
        .filter(|t| sessions.contains_key(t))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let id = sessions
        .get(&token)
        .map(|s| s.profile.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let profile = Profile {
        id,
        name: name.into(),
        avatar_seed: input.avatar_seed,
    };
    sessions.insert(
        token.clone(),
        Session {
            profile: profile.clone(),
            touched: Instant::now(),
        },
    );
    Ok(Json(json!({"token":token,"profile":profile})))
}
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Profile, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    let mut sessions = state.sessions.write().await;
    let s = sessions
        .get_mut(token)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "身份已过期，请重新进入"))?;
    s.touched = Instant::now();
    Ok(s.profile.clone())
}
async fn rate_check(state: &AppState, id: &str) -> Result<(), ApiError> {
    let mut rate = state.rate.lock().await;
    let attempts = rate.entry(id.into()).or_default();
    attempts.retain(|t| t.elapsed() < Duration::from_secs(60));
    if attempts.len() >= 15 {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "操作太频繁，请一分钟后再试",
        ));
    }
    attempts.push(Instant::now());
    Ok(())
}
#[derive(Deserialize)]
struct CreateInput {
    #[serde(default)]
    practice: bool,
    #[serde(default = "default_round_limit")]
    round_limit: Option<u32>,
}
fn default_round_limit() -> Option<u32> {
    Some(8)
}
async fn create(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<CreateInput>,
) -> Result<Json<Value>, ApiError> {
    let profile = authenticate(&state, &headers).await?;
    if input.round_limit == Some(0) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "局数必须是正整数，不限局请使用血战到底",
        ));
    }
    rate_check(&state, &profile.id).await?;
    let mut membership = state.membership.lock().await;
    if let Some(code) = membership.get(&profile.id) {
        return Err(error(
            StatusCode::CONFLICT,
            &format!("你已在房间 {code}，请先返回该房间或退出"),
        ));
    }
    let mut rooms = state.rooms.write().await;
    if rooms.len() >= 2000 {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "房间暂时已满，请稍后再试",
        ));
    }
    let code = allocate_code(&rooms)
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "房间号已用完"))?;
    let host = profile.id.clone();
    let mut room = Room {
        code: code.clone(),
        practice: input.practice,
        host: host.clone(),
        players: vec![Player {
            profile,
            bot: false,
            ready: true,
            connection: None,
            managed: false,
            pending: false,
            score: 0,
            voice: None,
        }],
        game: None,
        round: 0,
        completed_rounds: 0,
        round_limit: if input.practice {
            None
        } else {
            input.round_limit
        },
        ended: false,
        abandoned_round: false,
        final_scores: vec![],
        last_settlement: None,
        bot_target: 0,
        retired_players: vec![],
        version: 0,
        changed: broadcast::channel(32).0,
        touched: Instant::now(),
        deadline: Instant::now(),
        deadline_ms: 0,
        seen: HashSet::new(),
        history: vec![],
    };
    if input.practice {
        for (name, seed) in [("阿橘", "bot-orange"), ("小满", "bot-moon")] {
            room.players.push(Player {
                profile: Profile {
                    id: Uuid::new_v4().to_string(),
                    name: name.into(),
                    avatar_seed: seed.into(),
                },
                bot: true,
                ready: true,
                connection: None,
                managed: false,
                pending: false,
                score: 0,
                voice: None,
            });
        }
        room.begin();
    }
    rooms.insert(code.clone(), Arc::new(Mutex::new(room)));
    membership.insert(host, code.clone());
    Ok(Json(json!({"code":code})))
}
fn allocate_code<T>(rooms: &HashMap<String, T>) -> Option<String> {
    let start = rand::rng().random_range(1000..10000);
    (0..9000)
        .map(|n| format!("{}", 1000 + (start - 1000 + n) % 9000))
        .find(|c| !rooms.contains_key(c))
}
async fn room_info(
    State(state): State<Shared>,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let reference = state
        .rooms
        .read()
        .await
        .get(&code)
        .cloned()
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "房间已解散或不存在，请联系房主获取新的邀请",
            )
        })?;
    let room = reference.lock().await;
    if room.practice || room.ended {
        return Err(error(StatusCode::NOT_FOUND, "房间已解散或不存在"));
    }
    Ok(Json(
        json!({"code":room.code,"count":room.players.len(),"round_limit":room.round_limit,
        "available":room.players.len()<8,
        "reason":if room.players.len()>=8 {"房间已满，请联系房主"} else if room.round>0 {"可加入等待，下一局发牌时参与"} else {"朋友正在等你入座"}}),
    ))
}
async fn persist_http(
    State(state): State<Shared>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mutation = request.method() == axum::http::Method::POST;
    let response = next.run(request).await;
    if mutation && response.status().is_success() {
        persistence::checkpoint(&state).await;
    }
    response
}
async fn join(
    State(state): State<Shared>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let profile = authenticate(&state, &headers).await?;
    rate_check(&state, &profile.id).await?;
    let mut membership = state.membership.lock().await;
    if membership.get(&profile.id).is_some_and(|c| c != &code) {
        return Err(error(StatusCode::CONFLICT, "请先退出当前房间"));
    }
    let room = state
        .rooms
        .read()
        .await
        .get(&code)
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "没有找到这个房间，请检查四位房间号"))?;
    let mut room = room.lock().await;
    if room.ended {
        return Err(error(StatusCode::NOT_FOUND, "房间已解散，请创建新的房间"));
    }
    if !room.players.iter().any(|p| p.profile.id == profile.id) {
        if room.practice {
            return Err(error(StatusCode::FORBIDDEN, "练习房间仅供本人使用"));
        }
        if room.players.len() >= 8 {
            return Err(error(StatusCode::CONFLICT, "房间已满，最多八位玩家"));
        }
        membership.insert(profile.id.clone(), code.clone());
        let pending = room.game.is_some();
        room.players.push(Player {
            profile,
            bot: false,
            ready: pending,
            connection: None,
            managed: false,
            pending,
            score: 0,
            voice: None,
        });
        room.bot_target = room
            .bot_target
            .min(8 - room.players.iter().filter(|p| !p.bot).count());
        room.publish();
    }
    Ok(Json(json!({"code":code})))
}
async fn leave(
    State(state): State<Shared>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let profile = authenticate(&state, &headers).await?;
    let mut membership = state.membership.lock().await;
    let room_ref = state.rooms.read().await.get(&code).cloned();
    if let Some(room_ref) = room_ref {
        let mut room = room_ref.lock().await;
        if let Some(seat) = room.players.iter().position(|p| p.profile.id == profile.id) {
            if room.players[seat].pending {
                room.players.remove(seat);
                membership.remove(&profile.id);
                room.publish();
                return Ok(Json(json!({"ok":true})));
            }
            if room.game.as_ref().is_some_and(|g| g.winner.is_none()) && !room.practice {
                return Err(error(
                    StatusCode::CONFLICT,
                    "本局还没结束，暂时离开可关闭页面，座位会保留",
                ));
            }
            // A match keeps its original seats and their accumulated scores until dissolution.
            if !room.practice && room.round > 0 && !room.ended {
                room.players[seat].connection = None;
                room.players[seat].managed = true;
                room.players[seat].voice = None;
                if room.host == profile.id
                    && let Some(next) = room
                        .players
                        .iter()
                        .find(|p| p.profile.id != profile.id && p.connection.is_some())
                {
                    room.host = next.profile.id.clone();
                }
                room.publish();
                return Ok(Json(json!({"ok":true,"seat_retained":true})));
            }
            // Clearing a finished round preserves alignment after seat removal.
            room.game = None;
            room.players.remove(seat);
            if membership
                .get(&profile.id)
                .is_some_and(|current| current == &code)
            {
                membership.remove(&profile.id);
            }
            if let Some(p) = room.players.iter_mut().find(|p| !p.bot) {
                p.ready = true;
                let next_host = p.profile.id.clone();
                room.host = next_host;
            }
            room.publish();
        }
        let remove = !room.players.iter().any(|p| !p.bot);
        drop(room);
        if remove {
            state.rooms.write().await.remove(&code);
        }
    } else {
        if membership
            .get(&profile.id)
            .is_some_and(|current| current == &code)
        {
            membership.remove(&profile.id);
        }
    }
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
struct AuthMessage {
    token: String,
    code: String,
}
#[derive(Deserialize)]
struct Command {
    action: String,
    request_id: String,
    #[serde(default)]
    bot_count: Option<usize>,
    version: u64,
    #[serde(default)]
    cards: Vec<Card>,
}
async fn ws(State(state): State<Shared>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(8192)
        .max_frame_size(8192)
        .on_upgrade(move |socket| connection(state, socket))
}
async fn connection(state: Shared, mut socket: WebSocket) {
    if state.stopping.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let auth = match tokio::time::timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<AuthMessage>(&text).ok(),
        _ => None,
    };
    let Some(auth) = auth else {
        return;
    };
    let profile = state
        .sessions
        .read()
        .await
        .get(&auth.token)
        .map(|s| s.profile.clone());
    let room_ref = state.rooms.read().await.get(&auth.code).cloned();
    let (Some(profile), Some(room_ref)) = (profile, room_ref) else {
        let _ = socket
            .send(Message::Text(
                json!({"type":"fatal","error":"身份或房间已过期，请返回首页"})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    let connection_id = Uuid::new_v4().to_string();
    let mut events = {
        let mut room = room_ref.lock().await;
        if room.ended {
            drop(room);
            let _ = socket
                .send(Message::Text(
                    json!({"type":"fatal","error":"房间已解散，请返回大厅"})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
        let seat = room.players.iter().position(|p| p.profile.id == profile.id);
        let Some(player) = room.players.iter_mut().find(|p| p.profile.id == profile.id) else {
            drop(room);
            let _ = socket
                .send(Message::Text(
                    json!({"type":"fatal","error":"你已不在这个房间，请返回首页"})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        };
        player.connection = Some(connection_id.clone());
        player.profile = profile.clone();
        room.connection_changed(seat.unwrap());
        room.changed.subscribe()
    };
    let snapshot = room_ref.lock().await.snapshot(&profile.id);
    if socket
        .send(Message::Text(snapshot.to_string().into()))
        .await
        .is_err()
    {
        let mut room = room_ref.lock().await;
        if let Some(p) = room
            .players
            .iter_mut()
            .find(|p| p.profile.id == profile.id && p.connection.as_deref() == Some(&connection_id))
        {
            p.connection = None;
            p.managed = true;
            let seat = room
                .players
                .iter()
                .position(|p| p.profile.id == profile.id)
                .unwrap();
            room.connection_changed(seat);
        }
        return;
    }
    let (mut tx, mut rx) = socket.split();
    let mut recent = Vec::new();
    let mut last_input = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    loop {
        if state.stopping.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        tokio::select! {
            _ = state.shutdown.notified() => { break; }
            _ = heartbeat.tick() => {
                if last_input.elapsed() > Duration::from_secs(60) { break; }
            }
            notification = events.recv() => {
                if matches!(notification,Err(broadcast::error::RecvError::Closed)) { break; }
                let room = room_ref.lock().await;
                let player = room.players.iter().find(|p| p.profile.id==profile.id);
                if player.is_none_or(|p| p.connection.as_deref()!=Some(&connection_id)) {
                    drop(room);
                    let _=tx.send(Message::Text(json!({"type":"fatal","error":"这个身份已在另一页入座，请在那一页继续游玩"}).to_string().into())).await;
                    break;
                }
                let snapshot = room.snapshot(&profile.id);
                let ended = room.ended;
                drop(room);
                if tx.send(Message::Text(snapshot.to_string().into())).await.is_err() { break; }
                if ended { break; }
            }
            incoming = rx.next() => {
                last_input = Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        recent.retain(|t: &Instant| t.elapsed()<Duration::from_secs(1));
                        if recent.len()>=12 { break; }
                        recent.push(Instant::now());
                        if let Some(session)=state.sessions.write().await.get_mut(&auth.token) { session.touched=Instant::now(); }
                        let response = match serde_json::from_str::<Command>(&text) {
                            Ok(cmd) => {
                                let mut room = room_ref.lock().await;
                                if !room.players.iter().any(|p| p.profile.id==profile.id && p.connection.as_deref()==Some(&connection_id)) {
                                    drop(room);
                                    let _=tx.send(Message::Text(json!({"type":"fatal","error":"这个身份已在另一页入座，请在那一页继续游玩"}).to_string().into())).await;
                                    break;
                                }
                                let response = handle(&mut room,&profile.id,cmd);
                                let ended = room.ended;
                                drop(room);
                                if ended { dissolve(&state, &auth.code, &room_ref).await; }
                                persistence::checkpoint(&state).await;
                                response
                            }
                            Err(_) => Some(json!({"type":"error","error":"无法识别操作"})),
                        };
                        if let Some(response) = response && tx.send(Message::Text(response.to_string().into())).await.is_err() { break; }
                    }
                    Some(Ok(Message::Ping(data))) => { if tx.send(Message::Pong(data)).await.is_err() { break; } }
                    Some(Ok(Message::Pong(_))) => {}
                    _ => break,
                }
            }
        }
    }
    let mut room = room_ref.lock().await;
    if let Some(player) = room
        .players
        .iter_mut()
        .find(|p| p.profile.id == profile.id && p.connection.as_deref() == Some(&connection_id))
    {
        player.connection = None;
        player.managed = true;
        let seat = room
            .players
            .iter()
            .position(|p| p.profile.id == profile.id)
            .unwrap();
        room.connection_changed(seat);
    }
    drop(room);
    persistence::checkpoint(&state).await;
}
async fn dissolve(state: &AppState, code: &str, room_ref: &RoomRef) {
    let mut membership = state.membership.lock().await;
    let mut rooms = state.rooms.write().await;
    if rooms
        .get(code)
        .is_some_and(|current| Arc::ptr_eq(current, room_ref))
    {
        rooms.remove(code);
        membership.retain(|_, current| current != code);
    }
}
fn handle(room: &mut Room, id: &str, cmd: Command) -> Option<Value> {
    if cmd.action == "ping" {
        return Some(json!({"type":"pong"}));
    }
    let result = (|| -> Result<Option<Value>, String> {
        let seat = room
            .players
            .iter()
            .position(|p| p.profile.id == id)
            .ok_or("你已不在房间内")?;
        if cmd.request_id.is_empty() || cmd.request_id.len() > 80 {
            return Err("无效操作编号".into());
        }
        let key = format!("{id}:{}", cmd.request_id);
        if room.seen.contains(&key) {
            return Ok(Some(room.snapshot(id)));
        }
        if room.ended {
            return Err("游戏已结束，请返回大厅重新开房".into());
        }
        if room.players[seat].pending
            && matches!(
                cmd.action.as_str(),
                "hint" | "play" | "pass" | "auto_pass" | "takeover" | "resume"
            )
        {
            return Err("你将在下一局发牌时参与，请稍候".into());
        }
        if cmd.action == "hint" {
            let g = room.game.as_ref().ok_or("牌局还没开始")?;
            let hint = if room.practice && room.round == 1 && g.discarded.is_empty() && seat == 0 {
                vec![0]
            } else {
                legal_moves(&g.hands[seat], g.last.as_ref().map(|p| &p.pattern))
                    .into_iter()
                    .next()
                    .unwrap_or_default()
            };
            return Ok(Some(
                json!({"type":"hint","cards":hint,"version":room.version}),
            ));
        }
        if cmd.version != room.version
            && !matches!(
                cmd.action.as_str(),
                "ready_on" | "ready_off" | "takeover" | "resume" | "set_bots"
            )
        {
            return Err("牌桌状态已更新，请重新操作".into());
        }
        match cmd.action.as_str() {
            "set_bots" => {
                if room.practice || room.host != id {
                    return Err("只有房主可以调整机器人数量".into());
                }
                let count = cmd.bot_count.ok_or("请选择机器人数量")?;
                let humans = room.players.iter().filter(|p| !p.bot).count();
                if count > 8 - humans {
                    return Err("真人和机器人合计最多八人".into());
                }
                room.bot_target = count;
                if room.game.is_none() {
                    room.apply_bots();
                }
            }
            "end" => {
                if room.host != id {
                    return Err("只有房主可以结束游戏".into());
                }
                room.finish("房主结束了游戏，房间已解散");
            }
            "ready" | "ready_on" | "ready_off" => {
                if room.game.is_some() && !room.players[seat].pending {
                    return Err("牌局已经开始".into());
                }
                room.players[seat].ready = match cmd.action.as_str() {
                    "ready_on" => true,
                    "ready_off" => false,
                    _ => !room.players[seat].ready,
                };
            }
            "start" | "next" => {
                if room.host != id {
                    return Err("只有房主可以开始".into());
                }
                if room.players.iter().filter(|p| !p.bot).count() + room.bot_target < 2
                    && !room.practice
                {
                    return Err("至少需要两位玩家".into());
                }
                if room.game.as_ref().is_some_and(|g| g.winner.is_none()) {
                    return Err("本局还没结束".into());
                }
                if !room
                    .players
                    .iter()
                    .all(|p| p.ready && (p.bot || p.connection.is_some() || room.round > 0))
                {
                    return Err("首次开局需要所有玩家在线并准备".into());
                }
                room.begin();
            }
            "takeover" | "resume" => {
                if room.practice || room.game.is_none() {
                    return Err("开局后才能使用托管".into());
                }
                room.players[seat].managed = cmd.action == "takeover";
                room.add_history(format!(
                    "{}{}",
                    room.players[seat].profile.name,
                    if cmd.action == "takeover" {
                        " 开启了机器托管"
                    } else {
                        " 恢复了自己出牌"
                    }
                ));
            }
            "play" | "pass" | "auto_pass" => {
                if !room.practice && room.players[seat].managed {
                    return Err("请先恢复自己出牌".into());
                }
                let game = room.game.as_mut().ok_or("牌局还没开始")?;
                let name = room.players[seat].profile.name.clone();
                if cmd.action == "play" {
                    let count = cmd.cards.len();
                    game.play(seat, cmd.cards)?;
                    room.add_history(format!("{name} 出了 {count} 张牌"));
                } else {
                    if cmd.action == "auto_pass"
                        && (game.last.is_none()
                            || !legal_moves(
                                &game.hands[seat],
                                game.last.as_ref().map(|p| &p.pattern),
                            )
                            .is_empty())
                    {
                        return Err("有牌可以接，不能自动过牌".into());
                    }
                    game.pass(seat)?;
                    room.add_history(if cmd.action == "auto_pass" {
                        format!("{name} 要不起，自动过牌")
                    } else {
                        format!("{name} 过牌")
                    });
                }
                room.settle();
            }
            _ => return Err("未知操作".into()),
        }
        if room.seen.len() > 2048 {
            room.seen.clear();
        }
        room.seen.insert(key);
        room.update();
        Ok(None)
    })();
    match result {
        Ok(value) => value,
        Err(message) => Some(json!({"type":"error","error":message})),
    }
}

async fn tick(state: Shared) {
    let mut timer = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! { _ = timer.tick() => {}, _ = state.shutdown.notified() => break }
        if state.stopping.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let rooms: Vec<_> = state
            .rooms
            .read()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut expired = vec![];
        let mut dirty = false;
        for (code, room_ref) in rooms {
            let mut room = room_ref.lock().await;
            if room.ended {
                drop(room);
                dissolve(&state, &code, &room_ref).await;
                dirty = true;
                continue;
            }
            if room.touched.elapsed() > Duration::from_secs(3600) {
                expired.push(code);
                continue;
            }
            let previous_version = room.version;
            room.advance_timeout();
            let advanced = room.version != previous_version;
            if room.ended {
                drop(room);
                dissolve(&state, &code, &room_ref).await;
            } else {
                drop(room);
            }
            if advanced {
                dirty = true;
            }
        }
        if !expired.is_empty() {
            dirty = true;
            let mut membership = state.membership.lock().await;
            let mut rooms = state.rooms.write().await;
            for code in expired {
                rooms.remove(&code);
                membership.retain(|_, c| c != &code);
            }
        }
        {
            let mut sessions = state.sessions.write().await;
            let previous = sessions.len();
            sessions.retain(|_, s| s.touched.elapsed() < Duration::from_secs(86400));
            dirty |= sessions.len() != previous;
        }
        if dirty {
            persistence::checkpoint(&state).await;
        }
        state.rate.lock().await.retain(|_, attempts| {
            attempts.retain(|t| t.elapsed() < Duration::from_secs(60));
            !attempts.is_empty()
        });
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kantengyen_server=info,tower_http=info".into()),
        )
        .init();
    let turn_config = embedded_turn::Config::from_env().expect("内置 TURN 配置无效");
    let state = Arc::new(AppState {
        store: persistence::Store::from_env(),
        voice_config: voice::VoiceConfig::from_env(turn_config.as_ref())
            .expect("语音 ICE/TURN 配置无效"),
        ..AppState::default()
    });
    let restored = state
        .store
        .load(&state)
        .await
        .expect("无法恢复状态文件，保留文件后检查配置");
    state
        .store
        .save(&state)
        .await
        .expect("状态目录无法写入，检查 STATE_PATH 与目录权限");
    tracing::info!(restored, "已恢复对局状态");
    tokio::spawn(tick(state.clone()));
    let router = Router::new()
        .route(
            "/api/health",
            get(|State(state): State<Shared>| async move {
                let ok = !state
                    .storage_error
                    .load(std::sync::atomic::Ordering::Relaxed);
                (
                    if ok {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    Json(json!({"ok":ok,"version":"0.1.0"})),
                )
            }),
        )
        .route("/api/session", post(session))
        .route("/api/rooms", post(create))
        .route("/api/rooms/{code}", get(room_info))
        .route("/api/rooms/{code}/join", post(join))
        .route("/api/rooms/{code}/leave", post(leave))
        .route("/api/ws", get(ws))
        .route("/api/voice", get(voice::upgrade))
        .fallback(assets::serve)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            persist_http,
        ))
        .with_state(state.clone());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("无法绑定服务地址");
    let turn_server = match turn_config {
        Some(config) => Some(config.start().await.expect("无法启动内置 TURN")),
        None => None,
    };
    tracing::info!("干瞪眼服务已启动：http://{bind}");
    let shutdown_state = state.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            shutdown_state
                .stopping
                .store(true, std::sync::atomic::Ordering::Relaxed);
            shutdown_state.shutdown.notify_waiters();
            persistence::checkpoint(&shutdown_state).await;
        })
        .await
        .unwrap();
    persistence::checkpoint(&state).await;
    if let Some(server) = turn_server {
        let _ = server.close().await;
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("无法注册 SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_room() -> Room {
        Room {
            code: "1234".into(),
            practice: true,
            host: "0".into(),
            players: (0..2)
                .map(|i| Player {
                    profile: Profile {
                        id: i.to_string(),
                        name: format!("玩家{i}"),
                        avatar_seed: i.to_string(),
                    },
                    bot: false,
                    ready: true,
                    connection: None,
                    managed: false,
                    pending: false,
                    score: 0,
                    voice: None,
                })
                .collect(),
            game: Some(Game::deal((0..DECK_SIZE).collect(), 2, 0)),
            round: 1,
            completed_rounds: 0,
            round_limit: None,
            ended: false,
            abandoned_round: false,
            final_scores: vec![],
            last_settlement: None,
            bot_target: 0,
            retired_players: vec![],
            version: 0,
            changed: broadcast::channel(32).0,
            touched: Instant::now(),
            deadline: Instant::now(),
            deadline_ms: 0,
            seen: HashSet::new(),
            history: vec![],
        }
    }
    #[test]
    fn final_round_keeps_settlement_after_game_is_removed() {
        let mut room = test_room();
        room.practice = false;
        room.round_limit = Some(1);
        let game = room.game.as_mut().unwrap();
        game.hands = vec![vec![], vec![1, 2, 3, 4, 5]];
        game.winner = Some(0);
        game.multiplier = 2;
        game.result = vec![10, -10];
        room.settle();
        assert!(room.ended && room.game.is_none());
        let snapshot = room.snapshot("0");
        assert_eq!(snapshot["settlement"]["multiplier"], 2);
        assert_eq!(snapshot["settlement"]["entries"][1]["remaining"], 5);
        assert_eq!(snapshot["settlement"]["entries"][1]["contribution"], 10);
        assert_eq!(room.players.iter().map(|p| p.score).sum::<i64>(), 0);
    }
    #[test]
    fn readiness_desired_state_is_idempotent_even_with_stale_versions() {
        let mut room = test_room();
        room.game = None;
        room.round = 0;
        for (action, ready) in [
            ("ready_off", false),
            ("ready_off", false),
            ("ready_on", true),
            ("ready_on", true),
        ] {
            let command = Command {
                action: action.into(),
                version: 0,
                cards: vec![],
                bot_count: None,
                request_id: Uuid::new_v4().to_string(),
            };
            assert!(handle(&mut room, "1", command).is_none());
            assert_eq!(room.players[1].ready, ready);
        }
    }
    #[test]
    fn ending_a_live_room_is_host_only_and_freezes_scores() {
        let mut room = test_room();
        room.players[0].score = -12;
        room.players[1].score = 12;
        room.completed_rounds = 3;
        let command = |version| Command {
            action: "end".into(),
            request_id: "end-once".into(),
            version,
            cards: vec![],
            bot_count: None,
        };
        assert_eq!(handle(&mut room, "1", command(0)).unwrap()["type"], "error");
        assert!(!room.ended);
        assert!(handle(&mut room, "0", command(0)).is_none());
        let snapshot = room.snapshot("1");
        assert_eq!(snapshot["phase"], "ended");
        assert_eq!(snapshot["completed_rounds"], 3);
        assert_eq!(snapshot["abandoned_round"], true);
        assert_eq!(snapshot["final_scores"][0]["id"], "1");
        assert_eq!(snapshot["final_scores"][0]["score"], 12);
        assert_eq!(snapshot["final_scores"][0]["rank"], 1);
        assert_eq!(room.players[0].score, -12);
        assert!(room.game.is_none());
        assert_eq!(
            handle(&mut room, "0", command(0)).unwrap()["phase"],
            "ended"
        );
        for action in [
            "start",
            "next",
            "play",
            "pass",
            "auto_pass",
            "ready",
            "hint",
        ] {
            let version = room.version;
            assert_eq!(
                handle(
                    &mut room,
                    "0",
                    Command {
                        action: action.into(),
                        request_id: action.into(),
                        version,
                        cards: vec![0],
                        bot_count: None,
                    }
                )
                .unwrap()["type"],
                "error"
            );
        }
        room.players.remove(0);
        assert_eq!(room.snapshot("1")["final_scores"], snapshot["final_scores"]);
    }
    #[test]
    fn ending_after_a_finished_round_preserves_the_settled_result() {
        let mut room = test_room();
        let game = room.game.as_mut().unwrap();
        game.hands = vec![vec![0], vec![1, 8]];
        game.play(0, vec![0]).unwrap();
        room.settle();
        assert_eq!(room.completed_rounds, 1);
        let scores: Vec<_> = room.players.iter().map(|p| p.score).collect();
        assert!(scores[0] > 0);
        assert!(
            handle(
                &mut room,
                "0",
                Command {
                    action: "end".into(),
                    request_id: "end".into(),
                    version: 0,
                    cards: vec![],
                    bot_count: None,
                }
            )
            .is_none()
        );
        assert!(!room.abandoned_round);
        assert_eq!(room.completed_rounds, 1);
        assert_eq!(
            room.players.iter().map(|p| p.score).collect::<Vec<_>>(),
            scores
        );
    }
    #[tokio::test]
    async fn leaving_retains_scores_and_new_players_wait_for_next_round() {
        let state = Arc::new(AppState::default());
        let mut room = test_room();
        room.practice = false;
        for p in &mut room.players {
            p.connection = Some(format!("connection-{}", p.profile.id));
        }
        let game = room.game.as_mut().unwrap();
        game.hands = vec![vec![0], vec![1, 8]];
        game.play(0, vec![0]).unwrap();
        room.settle();
        assert_eq!(
            room.players.iter().map(|p| p.score).collect::<Vec<_>>(),
            vec![2, -2]
        );
        for player in &room.players {
            state.sessions.write().await.insert(
                player.profile.id.clone(),
                Session {
                    profile: player.profile.clone(),
                    touched: Instant::now(),
                },
            );
            state
                .membership
                .lock()
                .await
                .insert(player.profile.id.clone(), room.code.clone());
        }
        let room_ref = Arc::new(Mutex::new(room));
        state
            .rooms
            .write()
            .await
            .insert("1234".into(), room_ref.clone());
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer 0".parse().unwrap());
        assert!(
            leave(State(state.clone()), Path("1234".into()), headers)
                .await
                .is_ok()
        );
        let mut room = room_ref.lock().await;
        assert_eq!(room.players.len(), 2);
        assert_eq!(
            room.players.iter().map(|p| p.score).collect::<Vec<_>>(),
            vec![2, -2]
        );
        assert_eq!(room.host, "1");
        assert_eq!(room.round, 1);
        assert!(room.players[0].connection.is_none());
        let version = room.version;
        assert!(
            handle(
                &mut room,
                "1",
                Command {
                    action: "next".into(),
                    request_id: "next".into(),
                    version,
                    cards: vec![],
                    bot_count: None,
                }
            )
            .is_none()
        );
        assert_eq!(room.round, 2);
        assert_eq!(room.players.iter().map(|p| p.score).sum::<i64>(), 0);
        drop(room);
        assert_eq!(state.membership.lock().await.get("0").unwrap(), "1234");
        state.sessions.write().await.insert(
            "outsider".into(),
            Session {
                profile: Profile {
                    id: "outsider".into(),
                    name: "新玩家".into(),
                    avatar_seed: "outsider".into(),
                },
                touched: Instant::now(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer outsider".parse().unwrap());
        let _ = join(State(state.clone()), Path("1234".into()), headers)
            .await
            .unwrap();
        let mut room = room_ref.lock().await;
        assert!(room.players[2].pending);
        assert_eq!(room.snapshot("outsider")["hand"], Value::Null);
        assert_eq!(room.players[2].score, 0);
        room.begin();
        assert!(!room.players[2].pending);
        assert_eq!(room.game.as_ref().unwrap().hands.len(), 3);
    }
    #[test]
    fn robot_changes_apply_at_round_boundary_and_keep_retired_scores() {
        let mut room = test_room();
        room.practice = false;
        room.game = None;
        room.round = 0;
        let command = |count, id: &str, version| Command {
            action: "set_bots".into(),
            bot_count: Some(count),
            cards: vec![],
            request_id: id.into(),
            version,
        };
        assert!(handle(&mut room, "1", command(1, "guest", 0)).is_some());
        assert!(handle(&mut room, "0", command(7, "too-many", 0)).is_some());
        assert!(handle(&mut room, "0", command(1, "add", 0)).is_none());
        assert_eq!(room.players.len(), 3);
        room.begin();
        let version = room.version;
        assert!(handle(&mut room, "0", command(0, "remove", version)).is_none());
        assert_eq!(room.players.len(), 3);
        let game = room.game.as_mut().unwrap();
        game.winner = Some(0);
        game.hands = vec![vec![], vec![1], vec![2, 3]];
        game.result = vec![3, -1, -2];
        room.settle();
        room.begin();
        assert_eq!(room.players.len(), 2);
        assert_eq!(room.game.as_ref().unwrap().hands.len(), 2);
        assert_eq!(room.retired_players[0].score, -2);
        room.finish("结束");
        assert_eq!(
            room.final_scores
                .iter()
                .map(|p| p["score"].as_i64().unwrap())
                .sum::<i64>(),
            0
        );
    }
    #[test]
    fn automatic_pass_only_when_no_legal_response() {
        for (lead, response, unavailable) in [
            (vec![0], vec![2, 8], true),
            (vec![0], vec![1, 8], false),      // next rank
            (vec![0], vec![12, 8], false),     // 2 can respond
            (vec![0], vec![2, 15, 28], false), // bomb can respond
            (vec![0, 13], vec![1, 52], false), // small joker completes pair
            (vec![0, 13], vec![1, 53], false), // big joker completes pair
        ] {
            let mut room = test_room();
            let game = room.game.as_mut().unwrap();
            game.hands = vec![[lead.clone(), vec![10]].concat(), response];
            game.play(0, lead).unwrap();
            assert_eq!(room.snapshot("1")["auto_pass_available"], unavailable);
            let result = handle(
                &mut room,
                "1",
                Command {
                    action: "auto_pass".into(),
                    request_id: "test".into(),
                    version: 0,
                    cards: vec![],
                    bot_count: None,
                },
            );
            assert_eq!(result.is_none(), unavailable);
            if unavailable {
                assert!(room.history[0].contains("自动过牌"));
            } else {
                assert_eq!(room.game.as_ref().unwrap().turn, 1);
            }
        }
        let mut room = test_room();
        assert_eq!(room.snapshot("0")["auto_pass_available"], false);
        assert!(
            handle(
                &mut room,
                "0",
                Command {
                    action: "auto_pass".into(),
                    request_id: "lead".into(),
                    version: 0,
                    cards: vec![],
                    bot_count: None,
                }
            )
            .is_some()
        );
    }
    #[test]
    fn code_allocation_checks_collisions_and_exhaustion() {
        let mut rooms = HashMap::new();
        for code in 1000..10000 {
            rooms.insert(code.to_string(), ());
        }
        assert!(allocate_code(&rooms).is_none());
        rooms.remove("4321");
        assert_eq!(allocate_code(&rooms), Some("4321".into()));
    }
    #[test]
    fn round_options_default_to_eight_and_allow_unlimited_or_custom() {
        for (body, limit) in [
            ("{}", Some(8)),
            (r#"{"round_limit":16}"#, Some(16)),
            (r#"{"round_limit":20}"#, Some(20)),
            (r#"{"round_limit":3}"#, Some(3)),
            (r#"{"round_limit":null}"#, None),
        ] {
            assert_eq!(
                serde_json::from_str::<CreateInput>(body)
                    .unwrap()
                    .round_limit,
                limit
            );
        }
        assert!(serde_json::from_str::<CreateInput>(r#"{"round_limit":-1}"#).is_err());
        assert!(serde_json::from_str::<CreateInput>(r#"{"round_limit":1.5}"#).is_err());
    }
    #[test]
    fn final_round_settles_once_before_ending_and_unlimited_continues() {
        for limit in [Some(1), Some(8), Some(16), Some(20), Some(3), None] {
            let mut room = test_room();
            room.practice = false;
            room.round_limit = limit;
            room.round = limit.unwrap_or(100);
            room.completed_rounds = room.round - 1;
            let game = room.game.as_mut().unwrap();
            game.hands = vec![vec![0], vec![1, 8]];
            game.play(0, vec![0]).unwrap();
            room.settle();
            assert_eq!(room.completed_rounds, room.round);
            assert_eq!(room.ended, limit.is_some());
            assert!(!room.abandoned_round);
            let scores: Vec<_> = room.players.iter().map(|p| p.score).collect();
            assert!(scores[0] > 0);
            assert_eq!(scores.iter().sum::<i64>(), 0);
            room.settle();
            assert_eq!(
                scores,
                room.players.iter().map(|p| p.score).collect::<Vec<_>>()
            );
        }
    }
    #[test]
    fn offline_players_play_any_legal_response_and_pass_only_when_unable() {
        for (lead, response, plays) in [
            (vec![0], vec![1, 8], true),
            (vec![0], vec![12, 8], true),
            (vec![0], vec![2, 15, 28, 8], true),
            (vec![0, 13], vec![1, 52, 8], true),
            (vec![0], vec![2, 8], false),
        ] {
            let mut room = test_room();
            room.practice = false;
            let game = room.game.as_mut().unwrap();
            game.hands = vec![[lead.clone(), vec![10]].concat(), response];
            game.play(0, lead).unwrap();
            room.advance_timeout();
            let game = room.game.as_ref().unwrap();
            assert_eq!(game.last.as_ref().is_some_and(|p| p.seat == 1), plays);
            assert!(room.history[0].contains("机器代打"));
        }
    }
    #[test]
    fn disconnect_accelerates_turn_and_reconnect_requires_explicit_resume() {
        let mut room = test_room();
        room.practice = false;
        room.players[0].connection = Some("online".into());
        room.update();
        assert!(room.deadline.duration_since(Instant::now()) > Duration::from_secs(29));
        room.players[0].connection = None;
        room.connection_changed(0);
        assert!(room.deadline.duration_since(Instant::now()) <= Duration::from_millis(900));
        assert_eq!(room.snapshot("1")["players"][0]["auto_play"], true);
        room.players[0].connection = Some("reconnected".into());
        room.connection_changed(0);
        assert_eq!(room.snapshot("1")["players"][0]["auto_play"], true);
        assert!(
            handle(
                &mut room,
                "0",
                Command {
                    action: "resume".into(),
                    request_id: "resume".into(),
                    version: 0,
                    cards: vec![],
                    bot_count: None,
                }
            )
            .is_none()
        );
        assert_eq!(room.snapshot("1")["players"][0]["auto_play"], false);
        assert!(room.deadline.duration_since(Instant::now()) > Duration::from_secs(29));
        let before = room.game.as_ref().unwrap().hands[0].clone();
        room.advance_timeout();
        assert_eq!(room.game.as_ref().unwrap().hands[0], before);
    }
    #[tokio::test]
    async fn dissolution_releases_every_membership_and_cannot_remove_reused_code() {
        let state = AppState::default();
        let room = Arc::new(Mutex::new(test_room()));
        state
            .rooms
            .write()
            .await
            .insert("1234".into(), room.clone());
        state.membership.lock().await.extend([
            ("0".into(), "1234".into()),
            ("1".into(), "1234".into()),
            ("other".into(), "5678".into()),
        ]);
        dissolve(&state, "1234", &room).await;
        assert!(!state.rooms.read().await.contains_key("1234"));
        assert_eq!(state.membership.lock().await.len(), 1);
        let replacement = Arc::new(Mutex::new(test_room()));
        state
            .rooms
            .write()
            .await
            .insert("1234".into(), replacement.clone());
        state
            .membership
            .lock()
            .await
            .insert("0".into(), "1234".into());
        dissolve(&state, "1234", &room).await;
        assert!(Arc::ptr_eq(
            state.rooms.read().await.get("1234").unwrap(),
            &replacement
        ));
        assert!(state.membership.lock().await.contains_key("0"));
    }
}
