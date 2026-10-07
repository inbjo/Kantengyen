use super::*;
use std::{io, path::PathBuf};

#[derive(Default)]
pub struct Store {
    path: Option<PathBuf>,
    writer: Mutex<()>,
}
#[derive(Serialize, Deserialize)]
struct SavedSession {
    token: String,
    profile: Profile,
    touched_ms: u64,
}
#[derive(Serialize, Deserialize)]
struct SavedRoom {
    state: Value,
    touched_ms: u64,
}
#[derive(Serialize, Deserialize)]
struct SavedState {
    format: u32,
    sessions: Vec<SavedSession>,
    rooms: Vec<SavedRoom>,
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
fn touched_ms(touched: Instant) -> u64 {
    now_ms().saturating_sub(touched.elapsed().as_millis() as u64)
}
impl Store {
    pub fn from_env() -> Self {
        let path = std::env::var("STATE_PATH").unwrap_or_else(|_| "data/state.json".into());
        Self {
            path: (!path.is_empty()).then(|| PathBuf::from(path)),
            writer: Mutex::new(()),
        }
    }
    pub async fn load(&self, app: &AppState) -> io::Result<usize> {
        let Some(path) = &self.path else {
            return Ok(0);
        };
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let saved: SavedState = serde_json::from_slice(&bytes).map_err(invalid)?;
        if saved.format != 1 {
            return Err(invalid("不支持的状态文件版本"));
        }
        let mut sessions = HashMap::new();
        for session in saved.sessions {
            if now_ms().saturating_sub(session.touched_ms) < 86_400_000 {
                sessions.insert(
                    session.token,
                    Session {
                        profile: session.profile,
                        touched: Instant::now()
                            .checked_sub(Duration::from_millis(
                                now_ms().saturating_sub(session.touched_ms),
                            ))
                            .unwrap_or_else(Instant::now),
                    },
                );
            }
        }
        let mut rooms = HashMap::new();
        let mut membership = HashMap::new();
        for saved_room in saved.rooms {
            if now_ms().saturating_sub(saved_room.touched_ms) >= 3_600_000 {
                continue;
            }
            let mut room: Room = serde_json::from_value(saved_room.state).map_err(invalid)?;
            if room.ended {
                continue;
            }
            if !(1..=8).contains(&room.players.len())
                || !room.players.iter().any(|p| p.profile.id == room.host)
            {
                return Err(invalid("房间人数或房主无效"));
            }
            if let Some(game) = &room.game {
                let count = room.players.iter().filter(|p| !p.pending).count();
                if game.hands.len() != count
                    || game.result.len() != count
                    || game.turn >= count
                    || game.dealer >= count
                {
                    return Err(invalid("牌局座位数据无效"));
                }
                let cards: Vec<_> = game
                    .hands
                    .iter()
                    .flatten()
                    .chain(&game.deck)
                    .chain(&game.discarded)
                    .copied()
                    .collect();
                if cards.iter().any(|&c| c >= DECK_SIZE)
                    || cards.iter().collect::<HashSet<_>>().len() != cards.len()
                {
                    return Err(invalid("牌局卡牌数据无效"));
                }
            }
            for player in &mut room.players {
                if !player.bot {
                    if membership
                        .insert(player.profile.id.clone(), room.code.clone())
                        .is_some()
                    {
                        return Err(invalid("玩家重复占座"));
                    }
                    // Restarted connections are gone. Give everyone a recovery window,
                    // then keep bots in control until the player explicitly resumes.
                    player.managed = !room.practice;
                }
            }
            room.version += 1;
            room.deadline = Instant::now() + Duration::from_secs(30);
            room.deadline_ms = now_ms() + 30_000;
            room.touched = Instant::now()
                .checked_sub(Duration::from_millis(
                    now_ms().saturating_sub(saved_room.touched_ms),
                ))
                .unwrap_or_else(Instant::now);
            if rooms
                .insert(room.code.clone(), Arc::new(Mutex::new(room)))
                .is_some()
            {
                return Err(invalid("重复房间号"));
            }
        }
        let count = rooms.len();
        *app.sessions.write().await = sessions;
        *app.rooms.write().await = rooms;
        *app.membership.lock().await = membership;
        Ok(count)
    }
    pub async fn save(&self, app: &AppState) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let _writer = self.writer.lock().await;
        let membership = app.membership.lock().await;
        let sessions = app
            .sessions
            .read()
            .await
            .iter()
            .map(|(token, session)| SavedSession {
                token: token.clone(),
                profile: session.profile.clone(),
                touched_ms: touched_ms(session.touched),
            })
            .collect();
        let refs: Vec<_> = app.rooms.read().await.values().cloned().collect();
        let mut rooms = Vec::new();
        for reference in refs {
            let room = reference.lock().await;
            if !room.ended {
                rooms.push(SavedRoom {
                    state: serde_json::to_value(&*room).map_err(invalid)?,
                    touched_ms: touched_ms(room.touched),
                });
            }
        }
        drop(membership);
        let bytes = serde_json::to_vec(&SavedState {
            format: 1,
            sessions,
            rooms,
        })
        .map_err(invalid)?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        tokio::fs::create_dir_all(parent).await?;
        let temporary = path.with_extension("json.tmp");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

pub async fn checkpoint(app: &AppState) {
    match app.store.save(app).await {
        Ok(()) => app
            .storage_error
            .store(false, std::sync::atomic::Ordering::Relaxed),
        Err(error) => {
            app.storage_error
                .store(true, std::sync::atomic::Ordering::Relaxed);
            tracing::error!(%error, "无法保存对局状态");
        }
    }
}
