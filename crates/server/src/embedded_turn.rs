//! Embedded IPv4/UDP TURN, with bounded public-facing resource use.
use async_trait::async_trait;
use std::{
    any::Any,
    collections::HashMap,
    env,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::{
    net::UdpSocket,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use turn::{
    auth::{AuthHandler, generate_auth_key},
    relay::RelayAddressGenerator,
    server::{
        Server,
        config::{ConnConfig, ServerConfig},
    },
};
use webrtc_util::{Conn, Error as NetError};

#[derive(Clone)]
pub struct Config {
    pub public_ip: Ipv4Addr,
    pub public_host: String,
    pub bind: SocketAddrV4,
    pub relay_ip: Ipv4Addr,
    pub min_port: u16,
    pub max_port: u16,
    pub max_allocations: usize,
    pub bytes_per_second: usize,
    pub secret: String,
}

impl Config {
    pub fn from_env() -> Result<Option<Self>, String> {
        match env::var("TURN_ENABLED")
            .unwrap_or_else(|_| "false".into())
            .as_str()
        {
            "false" | "0" => return Ok(None),
            "true" | "1" => {}
            _ => return Err("TURN_ENABLED 必须为 true/false".into()),
        }
        let public_ip = env::var("TURN_PUBLIC_IP")
            .unwrap_or_default()
            .parse::<Ipv4Addr>()
            .map_err(|_| "启用内置 TURN 时必须设置 TURN_PUBLIC_IP 为服务器公网 IPv4")?;
        if !public_peer(public_ip) {
            return Err("TURN_PUBLIC_IP 必须是公网 IPv4".into());
        }
        let public_host = env::var("TURN_PUBLIC_HOST")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| public_ip.to_string());
        if public_host.len() > 253
            || !public_host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err("TURN_PUBLIC_HOST 必须是域名或 IPv4，不能包含协议、路径或端口".into());
        }
        let bind = env::var("TURN_BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:3478".into())
            .parse::<SocketAddrV4>()
            .map_err(|_| "TURN_BIND_ADDR 必须是 IPv4:端口")?;
        let relay_ip = env::var("TURN_RELAY_IP")
            .unwrap_or_else(|_| "0.0.0.0".into())
            .parse()
            .map_err(|_| "TURN_RELAY_IP 必须是本机 IPv4")?;
        let min_port = number("TURN_MIN_PORT", 49160)?;
        let max_port = number("TURN_MAX_PORT", 49200)?;
        let max_allocations = number("TURN_MAX_ALLOCATIONS", 32)?;
        let bytes_per_second = number("TURN_BYTES_PER_SECOND", 128000)?;
        if bind.port() == 0
            || min_port < 1024
            || max_port < min_port
            || max_allocations == 0
            || max_allocations > 1024
            || bytes_per_second < 4096
            || bytes_per_second > 10_000_000
        {
            return Err("TURN 端口、并发或带宽配置超出允许范围".into());
        }
        let secret = env::var("VOICE_TURN_SECRET")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string()
            });
        if secret.len() < 32 {
            return Err("内置 TURN 的 VOICE_TURN_SECRET 至少需要 32 字节".into());
        }
        Ok(Some(Self {
            public_ip,
            public_host,
            bind,
            relay_ip,
            min_port,
            max_port,
            max_allocations,
            bytes_per_second,
            secret,
        }))
    }

    pub fn turn_url(&self) -> String {
        format!(
            "turn:{}:{}?transport=udp",
            self.public_host,
            self.bind.port()
        )
    }
    pub fn stun_url(&self) -> String {
        format!("stun:{}:{}", self.public_host, self.bind.port())
    }

    pub async fn start(&self) -> Result<Runtime, turn::Error> {
        let ports = Arc::new(StdMutex::new(HashMap::new()));
        let policy = Arc::new(PeerPolicy {
            public_ip: self.public_ip,
            ports,
        });
        let listener = Arc::new(ListenerSocket {
            socket: UdpSocket::bind(self.bind).await?,
            clients: StdMutex::new(HashMap::new()),
            global: StdMutex::new(Budget::new(10_000_000)),
        });
        let server = Server::new(ServerConfig {
            conn_configs: vec![ConnConfig {
                conn: listener,
                relay_addr_generator: Box::new(RelayGenerator {
                    config: self.clone(),
                    policy,
                    slots: Arc::new(Semaphore::new(self.max_allocations)),
                }),
            }],
            realm: "kantengyen".into(),
            auth_handler: Arc::new(TemporaryAuth {
                secret: self.secret.clone(),
            }),
            channel_bind_timeout: Duration::from_secs(600),
            alloc_close_notify: None,
        })
        .await?;
        tracing::info!(bind = %self.bind, public_ip = %self.public_ip,
            min_port = self.min_port, max_port = self.max_port, "内置 TURN UDP 已启动");
        let server = Arc::new(server);
        let maintenance = tokio::spawn({
            let server = server.clone();
            async move {
                let mut interval = tokio::time::interval(Duration::from_secs(15));
                loop {
                    interval.tick().await;
                    let Ok(allocations) = server.get_allocations_info(None).await else {
                        break;
                    };
                    let now = crate::now_ms() / 1000;
                    for info in allocations.values() {
                        let expired = info
                            .username
                            .split_once(':')
                            .and_then(|(expiry, _)| expiry.parse::<u64>().ok())
                            .is_none_or(|expiry| expiry <= now);
                        if expired {
                            let _ = server
                                .delete_allocations_by_username(info.username.clone())
                                .await;
                        }
                    }
                }
            }
        });
        Ok(Runtime {
            server,
            maintenance,
        })
    }
}

pub struct Runtime {
    server: Arc<Server>,
    maintenance: JoinHandle<()>,
}
impl Runtime {
    pub async fn close(&self) -> Result<(), turn::Error> {
        self.maintenance.abort();
        self.server.close().await
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.maintenance.abort();
    }
}

fn number<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("{name} 必须是有效数字")),
        Err(_) => Ok(default),
    }
}

// A closed UDP peer may produce an ICMP error on Windows. It must not stop
// the shared listener (and all other players' allocations).
async fn recv_datagram(socket: &UdpSocket, buf: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> {
    loop {
        match socket.recv_from(buf).await {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::Interrupted
                ) => {}
            result => return result,
        }
    }
}

// IPv4-only: reject private, shared, metadata, multicast, loopback and reserved peers.
fn public_peer(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || b == 0))
        || (a == 198 && (b == 18 || b == 19))
        || ip == Ipv4Addr::BROADCAST)
}

struct TemporaryAuth {
    secret: String,
}
impl AuthHandler for TemporaryAuth {
    fn auth_handle(
        &self,
        username: &str,
        realm: &str,
        _: SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        let (expiry, id) = username.split_once(':').ok_or(turn::Error::ErrNoSuchUser)?;
        let expiry = expiry
            .parse::<u64>()
            .map_err(|_| turn::Error::ErrNoSuchUser)?;
        let now = crate::now_ms() / 1000;
        if realm != "kantengyen"
            || expiry <= now
            || expiry > now + 3600
            || uuid::Uuid::parse_str(id).is_err()
        {
            return Err(turn::Error::ErrNoSuchUser);
        }
        let password = crate::voice::turn_password(&self.secret, username);
        Ok(generate_auth_key(username, realm, &password))
    }
}

struct Budget {
    start: Instant,
    used: usize,
    limit: usize,
}
impl Budget {
    fn new(limit: usize) -> Self {
        Self {
            start: Instant::now(),
            used: 0,
            limit,
        }
    }
    fn allow(&mut self, count: usize) -> bool {
        if self.start.elapsed() >= Duration::from_secs(1) {
            self.start = Instant::now();
            self.used = 0;
        }
        if count > self.limit.saturating_sub(self.used) {
            return false;
        }
        self.used += count;
        true
    }
}

struct PeerPolicy {
    public_ip: Ipv4Addr,
    // Only active allocation ports may be used for local TURN-to-TURN routing.
    ports: Arc<StdMutex<HashMap<u16, SocketAddr>>>,
}
impl PeerPolicy {
    fn destination(&self, peer: SocketAddr) -> Option<SocketAddr> {
        let SocketAddr::V4(peer_v4) = peer else {
            return None;
        };
        if *peer_v4.ip() == self.public_ip {
            return self.ports.lock().unwrap().get(&peer.port()).copied();
        }
        public_peer(*peer_v4.ip()).then_some(peer)
    }
    fn source(&self, source: SocketAddr) -> Option<SocketAddr> {
        if self.ports.lock().unwrap().get(&source.port()) == Some(&source) {
            return Some(SocketAddr::new(self.public_ip.into(), source.port()));
        }
        match source {
            SocketAddr::V4(addr) if public_peer(*addr.ip()) => Some(source),
            _ => None,
        }
    }
}

struct RelayGenerator {
    config: Config,
    policy: Arc<PeerPolicy>,
    slots: Arc<Semaphore>,
}
#[async_trait]
impl RelayAddressGenerator for RelayGenerator {
    fn validate(&self) -> Result<(), turn::Error> {
        Ok(())
    }
    async fn allocate_conn(
        &self,
        ipv4: bool,
        requested: u16,
    ) -> Result<(Arc<dyn Conn + Send + Sync>, SocketAddr), turn::Error> {
        if !ipv4
            || (requested != 0
                && !(self.config.min_port..=self.config.max_port).contains(&requested))
        {
            return Err(turn::Error::ErrRelayAddressInvalid);
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| turn::Error::ErrMaxRetriesExceeded)?;
        let count = u32::from(self.config.max_port) - u32::from(self.config.min_port) + 1;
        let offset = rand::random::<u32>() % count;
        for index in 0..count {
            let port = if requested != 0 {
                requested
            } else {
                (u32::from(self.config.min_port) + (offset + index) % count) as u16
            };
            if let Ok(socket) = UdpSocket::bind((self.config.relay_ip, port)).await {
                let local_ip = if self.config.relay_ip.is_unspecified() {
                    Ipv4Addr::LOCALHOST
                } else {
                    self.config.relay_ip
                };
                self.policy
                    .ports
                    .lock()
                    .unwrap()
                    .insert(port, SocketAddr::new(local_ip.into(), port));
                let relay = Arc::new(RelaySocket {
                    socket,
                    policy: self.policy.clone(),
                    slot: StdMutex::new(Some(slot)),
                    inbound: StdMutex::new(Budget::new(self.config.bytes_per_second)),
                    outbound: StdMutex::new(Budget::new(self.config.bytes_per_second)),
                });
                return Ok((relay, SocketAddr::new(self.config.public_ip.into(), port)));
            }
            if requested != 0 {
                break;
            }
        }
        Err(turn::Error::ErrMaxRetriesExceeded)
    }
}

struct RelaySocket {
    socket: UdpSocket,
    policy: Arc<PeerPolicy>,
    slot: StdMutex<Option<OwnedSemaphorePermit>>,
    inbound: StdMutex<Budget>,
    outbound: StdMutex<Budget>,
}
impl RelaySocket {
    fn release(&self) {
        if self.slot.lock().unwrap().take().is_some() {
            if let Ok(addr) = self.socket.local_addr() {
                self.policy.ports.lock().unwrap().remove(&addr.port());
            }
        }
    }
}
impl Drop for RelaySocket {
    fn drop(&mut self) {
        self.release();
    }
}

#[async_trait]
impl Conn for RelaySocket {
    async fn connect(&self, _: SocketAddr) -> webrtc_util::Result<()> {
        Err(NetError::ErrHasNoPermission)
    }
    async fn recv(&self, buf: &mut [u8]) -> webrtc_util::Result<usize> {
        self.recv_from(buf).await.map(|(n, _)| n)
    }
    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        loop {
            let (n, source) = recv_datagram(&self.socket, buf).await?;
            if let Some(source) = self.policy.source(source) {
                if self.inbound.lock().unwrap().allow(n) {
                    return Ok((n, source));
                }
            }
        }
    }
    async fn send(&self, _: &[u8]) -> webrtc_util::Result<usize> {
        Err(NetError::ErrHasNoPermission)
    }
    async fn send_to(&self, buf: &[u8], peer: SocketAddr) -> webrtc_util::Result<usize> {
        let target = self
            .policy
            .destination(peer)
            .ok_or(NetError::ErrHasNoPermission)?;
        if !self.outbound.lock().unwrap().allow(buf.len()) {
            return Ok(buf.len());
        }
        Ok(self.socket.send_to(buf, target).await?)
    }
    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.socket.local_addr()?)
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }
    async fn close(&self) -> webrtc_util::Result<()> {
        self.release();
        Ok(())
    }
    fn as_any(&self) -> &(dyn Any + Send + Sync) {
        self
    }
}

struct ListenerSocket {
    socket: UdpSocket,
    clients: StdMutex<HashMap<std::net::IpAddr, (Instant, Budget, Budget)>>,
    global: StdMutex<Budget>,
}
#[async_trait]
impl Conn for ListenerSocket {
    async fn connect(&self, _: SocketAddr) -> webrtc_util::Result<()> {
        Err(NetError::ErrHasNoPermission)
    }
    async fn recv(&self, buf: &mut [u8]) -> webrtc_util::Result<usize> {
        self.recv_from(buf).await.map(|(n, _)| n)
    }
    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        loop {
            let (n, source) = recv_datagram(&self.socket, buf).await?;
            if !self.global.lock().unwrap().allow(n) {
                continue;
            }
            let allowed = {
                let mut clients = self.clients.lock().unwrap();
                if clients.len() >= 1024 {
                    clients.retain(|_, (seen, _, _)| seen.elapsed() < Duration::from_secs(60));
                }
                if !clients.contains_key(&source.ip()) && clients.len() >= 1024 {
                    false
                } else {
                    let (seen, packets, requests) = clients
                        .entry(source.ip())
                        .or_insert_with(|| (Instant::now(), Budget::new(2000), Budget::new(40)));
                    *seen = Instant::now();
                    // STUN requests (class 00), including unauthenticated allocations.
                    let request =
                        n >= 20 && buf[0] & 0xc0 == 0 && buf[0] & 1 == 0 && buf[1] & 0x10 == 0;
                    packets.allow(1) && (!request || requests.allow(1))
                }
            };
            if allowed {
                return Ok((n, source));
            }
        }
    }
    async fn send(&self, _: &[u8]) -> webrtc_util::Result<usize> {
        Err(NetError::ErrHasNoPermission)
    }
    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> webrtc_util::Result<usize> {
        Ok(self.socket.send_to(buf, target).await?)
    }
    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.socket.local_addr()?)
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }
    async fn close(&self) -> webrtc_util::Result<()> {
        Ok(())
    }
    fn as_any(&self) -> &(dyn Any + Send + Sync) {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;
    use turn::client::{Client, ClientConfig};

    async fn config() -> Config {
        let probe = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let bind = match probe.local_addr().unwrap() {
            SocketAddr::V4(addr) => addr,
            _ => unreachable!(),
        };
        Config {
            public_ip: Ipv4Addr::new(203, 0, 113, 10),
            public_host: "turn.example.com".into(),
            bind,
            relay_ip: Ipv4Addr::LOCALHOST,
            min_port: 49160,
            max_port: 49200,
            max_allocations: 2,
            bytes_per_second: 128000,
            secret: "s".repeat(64),
        }
    }

    async fn client(config: &Config, password: Option<String>) -> Client {
        let username = format!("{}:{}", crate::now_ms() / 1000 + 3600, uuid::Uuid::new_v4());
        let password =
            password.unwrap_or_else(|| crate::voice::turn_password(&config.secret, &username));
        let client = Client::new(ClientConfig {
            stun_serv_addr: config.bind.to_string(),
            turn_serv_addr: config.bind.to_string(),
            username,
            password,
            realm: "kantengyen".into(),
            software: "test".into(),
            rto_in_ms: 100,
            conn: Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()),
            vnet: None,
        })
        .await
        .unwrap();
        client.listen().await.unwrap();
        client
    }

    #[test]
    fn credentials_reject_expiry_wrong_realm_and_malformed_identity() {
        let auth = TemporaryAuth {
            secret: "s".repeat(64),
        };
        let id = uuid::Uuid::new_v4();
        let now = crate::now_ms() / 1000;
        let source = "127.0.0.1:12345".parse().unwrap();
        for username in [
            format!("{}:{id}", now - 1),
            format!("{}:{id}", now + 3601),
            format!("{}:invalid-id", now + 300),
            "invalid".into(),
        ] {
            assert!(auth.auth_handle(&username, "kantengyen", source).is_err());
        }
        let username = format!("{}:{id}", now + 300);
        assert!(auth.auth_handle(&username, "wrong-realm", source).is_err());
        let password = crate::voice::turn_password(&auth.secret, &username);
        assert_eq!(
            auth.auth_handle(&username, "kantengyen", source).unwrap(),
            generate_auth_key(&username, "kantengyen", &password)
        );
    }

    #[test]
    fn public_peer_policy_denies_internal_and_metadata_addresses() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.100.100.200",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!public_peer(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_peer("8.8.8.8".parse().unwrap()));
        let policy = PeerPolicy {
            public_ip: "1.2.3.4".parse().unwrap(),
            ports: Arc::new(StdMutex::new(HashMap::new())),
        };
        assert!(
            policy
                .destination("127.0.0.1:3000".parse().unwrap())
                .is_none()
        );
        assert!(
            policy
                .destination("[::ffff:127.0.0.1]:3000".parse().unwrap())
                .is_none()
        );
        assert!(
            policy
                .destination("1.2.3.4:3000".parse().unwrap())
                .is_none()
        );
    }

    #[tokio::test]
    async fn udp_turn_authentication_relay_and_allocation_limits() {
        timeout(Duration::from_secs(10), async {
            let config = config().await;
            let runtime = config.start().await.unwrap();
            let bad = client(&config, Some("incorrect-password".into())).await;
            assert!(bad.allocate().await.is_err());
            bad.close().await.unwrap();
            let a = client(&config, None).await;
            let b = client(&config, None).await;
            assert!(a.send_binding_request().await.is_ok());
            let ra = a.allocate().await.unwrap();
            let rb = b.allocate().await.unwrap();
            let addr_a = ra.local_addr().unwrap();
            let addr_b = rb.local_addr().unwrap();
            assert_eq!(addr_a.ip(), config.public_ip);
            assert!((config.min_port..=config.max_port).contains(&addr_a.port()));
            assert_ne!(addr_a, addr_b);
            // Establish both directions' TURN permissions before sending useful data.
            rb.send_to(b"warmup", addr_a).await.unwrap();
            ra.send_to(b"first", addr_b).await.unwrap();
            let mut buffer = [0; 64];
            let (n, source) = rb.recv_from(&mut buffer).await.unwrap();
            assert_eq!(&buffer[..n], b"first");
            assert_eq!(source, addr_a);
            rb.send_to(b"reply", addr_a).await.unwrap();
            loop {
                let (n, source) = ra.recv_from(&mut buffer).await.unwrap();
                if &buffer[..n] == b"reply" {
                    assert_eq!(source, addr_b);
                    break;
                }
            }
            let third = client(&config, None).await;
            assert!(third.allocate().await.is_err());
            assert_eq!(
                runtime
                    .server
                    .get_allocations_info(None)
                    .await
                    .unwrap()
                    .len(),
                2
            );
            ra.close().await.unwrap();
            rb.close().await.unwrap();
            third.close().await.unwrap();
            a.close().await.unwrap();
            b.close().await.unwrap();
            runtime.close().await.unwrap();
            assert!(
                UdpSocket::bind(config.bind).await.is_ok(),
                "listener port must be released on shutdown"
            );
        })
        .await
        .expect("TURN test exceeded timeout");
    }

    #[tokio::test]
    async fn relay_range_peer_filter_bandwidth_and_cleanup() {
        let config = config().await;
        let policy = Arc::new(PeerPolicy {
            public_ip: config.public_ip,
            ports: Arc::new(StdMutex::new(HashMap::new())),
        });
        let slots = Arc::new(Semaphore::new(1));
        let generator = RelayGenerator {
            config: config.clone(),
            policy: policy.clone(),
            slots: slots.clone(),
        };
        assert!(generator.allocate_conn(true, 3000).await.is_err());
        assert!(generator.allocate_conn(false, 0).await.is_err());
        let (conn, addr) = generator.allocate_conn(true, 0).await.unwrap();
        assert!(generator.allocate_conn(true, 0).await.is_err());
        for peer in ["127.0.0.1:3000", "10.0.0.1:80", "169.254.169.254:80"] {
            assert!(
                conn.send_to(b"blocked", peer.parse().unwrap())
                    .await
                    .is_err()
            );
        }
        let mut budget = Budget::new(100);
        assert!(budget.allow(100));
        assert!(!budget.allow(1));
        conn.close().await.unwrap();
        assert!(policy.destination(addr).is_none());
        assert_eq!(slots.available_permits(), 1);
        drop(conn);
        assert!(generator.allocate_conn(true, 0).await.is_ok());
    }
}
