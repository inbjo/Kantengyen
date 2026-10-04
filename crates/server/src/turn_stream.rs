//! TURN stream framing (RFC 8656), shared by TCP and TLS listeners.
use super::*;
use std::{io, path::PathBuf, sync::RwLock};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf},
    net::TcpListener,
    sync::{Mutex, watch},
    task::JoinSet,
    time::timeout,
};
use tokio_rustls::{TlsAcceptor, rustls};

#[derive(Clone)]
pub struct TlsConfig {
    pub bind: SocketAddrV4,
    pub public_port: u16,
    pub cert: PathBuf,
    pub key: PathBuf,
}

pub struct Certificates {
    paths: TlsConfig,
    current: Arc<RwLock<Arc<rustls::ServerConfig>>>,
    material: (Vec<u8>, Vec<u8>),
}
impl Certificates {
    pub fn new(paths: TlsConfig) -> io::Result<Self> {
        let material = (std::fs::read(&paths.cert)?, std::fs::read(&paths.key)?);
        let config = Self::parse(&material)?;
        Ok(Self {
            paths,
            current: Arc::new(RwLock::new(config)),
            material,
        })
    }
    fn parse(material: &(Vec<u8>, Vec<u8>)) -> io::Result<Arc<rustls::ServerConfig>> {
        let certs =
            rustls_pemfile::certs(&mut material.0.as_slice()).collect::<io::Result<Vec<_>>>()?;
        let key = rustls_pemfile::private_key(&mut material.1.as_slice())?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "TURN TLS PEM 文件中没有私钥")
        })?;
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(io::Error::other)?;
        Ok(Arc::new(config))
    }
    fn reload(&mut self) -> io::Result<()> {
        let material = (
            std::fs::read(&self.paths.cert)?,
            std::fs::read(&self.paths.key)?,
        );
        if material != self.material {
            let config = Self::parse(&material)?;
            *self.current.write().unwrap() = config;
            self.material = material;
            tracing::info!("TURN TLS 证书已重载，新连接使用新证书");
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn listen(
    listener: TcpListener,
    mut certs: Option<Certificates>,
    config: Config,
    policy: Arc<PeerPolicy>,
    slots: Arc<Semaphore>,
    ingress: Arc<Ingress>,
    connections: Arc<Semaphore>,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        let mut reload = tokio::time::interval(Duration::from_secs(60));
        let per_ip = Arc::new(StdMutex::new(
            HashMap::<std::net::IpAddr, Arc<Semaphore>>::new(),
        ));
        let local = listener.local_addr().unwrap();
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                _ = reload.tick(), if certs.is_some() => {
                    if let Err(error) = certs.as_mut().unwrap().reload() { tracing::warn!(%error, "TURN TLS 证书重载失败，保留现有证书"); }
                },
                accepted = listener.accept() => {
                    let Ok((socket, peer)) = accepted else { continue; };
                    while tasks.try_join_next().is_some() {}
                    let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
                    let ip_slots = {
                        let mut ips = per_ip.lock().unwrap();
                        ips.retain(|_, s| s.available_permits() != 64 || Arc::strong_count(s) > 1);
                        ips.entry(peer.ip()).or_insert_with(|| Arc::new(Semaphore::new(64))).clone()
                    };
                    let Ok(ip_permit) = ip_slots.try_acquire_owned() else { continue; };
                    let _ = socket.set_nodelay(true);
                    let tls = certs.as_ref().map(|c| TlsAcceptor::from(c.current.read().unwrap().clone()));
                    let (config, policy, slots, ingress, mut shutdown) = (config.clone(), policy.clone(), slots.clone(), ingress.clone(), shutdown.clone());
                    tasks.spawn(async move {
                        let (_permit, _ip_permit) = (permit, ip_permit);
                        let io: Box<dyn StreamIo> = if let Some(tls) = tls {
                            let handshake = tokio::select! {
                                _ = shutdown.changed() => return,
                                result = timeout(Duration::from_secs(10), tls.accept(socket)) => result,
                            };
                            match handshake { Ok(Ok(io)) => Box::new(io), _ => return }
                        } else { Box::new(socket) };
                        let conn = Arc::new(StreamConn::new(io, local, peer, ingress));
                        let Ok(server) = config.server(conn.clone(), policy, slots).await else { return; };
                        // Each accepted stream has an independent allocation manager. A TCP
                        // tuple cannot collide with a UDP tuple, even with identical ports.
                        let server = Arc::new(server);
                        let maintenance = tokio::spawn(maintain(server.clone()));
                        let mut closed = conn.closed.subscribe();
                        if !*closed.borrow() && !*shutdown.borrow() {
                            tokio::select! { _ = closed.changed() => {}, _ = shutdown.changed() => {} }
                        }
                        maintenance.abort();
                        let _ = server.close().await;
                        let _ = conn.close().await;
                    });
                }
            }
        }
        drop(listener);
        // The shared shutdown watch wakes every connection, including handshakes.
        while tasks.join_next().await.is_some() {}
    })
}

trait StreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> StreamIo for T {}

pub(super) struct StreamConn {
    reader: Mutex<ReadHalf<Box<dyn StreamIo>>>,
    writer: Mutex<WriteHalf<Box<dyn StreamIo>>>,
    local: SocketAddr,
    peer: SocketAddr,
    ingress: Arc<Ingress>,
    closed: watch::Sender<bool>,
}
impl StreamConn {
    fn new(
        io: Box<dyn StreamIo>,
        local: SocketAddr,
        peer: SocketAddr,
        ingress: Arc<Ingress>,
    ) -> Self {
        let (reader, writer) = tokio::io::split(io);
        let (closed, _) = watch::channel(false);
        Self {
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
            local,
            peer,
            ingress,
            closed,
        }
    }
}

async fn read_frame(reader: &mut (impl AsyncRead + Unpin), buf: &mut [u8]) -> io::Result<usize> {
    if buf.len() < 20 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "TURN 接收缓冲区太小",
        ));
    }
    timeout(Duration::from_secs(120), reader.read_exact(&mut buf[..4])).await??;
    let channel = buf[0] & 0xc0 == 0x40;
    let payload = usize::from(u16::from_be_bytes([buf[2], buf[3]]));
    let length = if channel { 4 + payload } else { 20 + payload };
    let padded = if channel { (length + 3) & !3 } else { length };
    if (!channel && (buf[0] & 0xc0 != 0 || payload % 4 != 0)) || padded > buf.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "无效或过大的 TURN 帧",
        ));
    }
    timeout(
        Duration::from_secs(10),
        reader.read_exact(&mut buf[4..padded]),
    )
    .await??;
    if !channel && buf[4..8] != [0x21, 0x12, 0xa4, 0x42] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "无效 STUN magic cookie",
        ));
    }
    Ok(length)
}

#[async_trait]
impl Conn for StreamConn {
    async fn connect(&self, _: SocketAddr) -> webrtc_util::Result<()> {
        Err(NetError::ErrHasNoPermission)
    }
    async fn recv(&self, buf: &mut [u8]) -> webrtc_util::Result<usize> {
        self.recv_from(buf).await.map(|(n, _)| n)
    }
    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into());
        }
        let mut reader = self.reader.lock().await;
        loop {
            let result = tokio::select! {
                _ = closed.changed() => Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                result = read_frame(&mut *reader, buf) => result,
            };
            match result {
                Ok(n) if self.ingress.allow(&buf[..n], self.peer) => return Ok((n, self.peer)),
                Ok(_) => {}
                Err(error) => {
                    self.closed.send_replace(true);
                    return Err(error.into());
                }
            }
        }
    }
    async fn send(&self, buf: &[u8]) -> webrtc_util::Result<usize> {
        self.send_to(buf, self.peer).await
    }
    async fn send_to(&self, buf: &[u8], peer: SocketAddr) -> webrtc_util::Result<usize> {
        if peer != self.peer || *self.closed.borrow() {
            return Err(NetError::ErrHasNoPermission);
        }
        let write = async {
            let mut writer = self.writer.lock().await;
            writer.write_all(buf).await?;
            if buf.first().is_some_and(|b| b & 0xc0 == 0x40) {
                let padding = (4 - buf.len() % 4) % 4;
                writer.write_all(&[0; 3][..padding]).await?;
            }
            writer.flush().await
        };
        match timeout(Duration::from_secs(5), write).await {
            Ok(Ok(())) => Ok(buf.len()),
            result => {
                self.closed.send_replace(true);
                Err(match result {
                    Ok(Err(error)) => error,
                    _ => io::Error::from(io::ErrorKind::TimedOut),
                }
                .into())
            }
        }
    }
    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.local)
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        Some(self.peer)
    }
    async fn close(&self) -> webrtc_util::Result<()> {
        self.closed.send_replace(true);
        let _ = timeout(Duration::from_secs(5), async {
            self.writer.lock().await.shutdown().await
        })
        .await;
        Ok(())
    }
    fn as_any(&self) -> &(dyn Any + Send + Sync) {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn client(config: &Config, conn: Arc<dyn Conn + Send + Sync>) -> turn::client::Client {
        let username = format!("{}:{}", crate::now_ms() / 1000 + 3600, uuid::Uuid::new_v4());
        let address = conn.remote_addr().unwrap_or(config.bind.into()).to_string();
        let client = turn::client::Client::new(turn::client::ClientConfig {
            stun_serv_addr: address.clone(),
            turn_serv_addr: address,
            password: crate::voice::turn_password(&config.secret, &username),
            username,
            realm: "kantengyen".into(),
            software: "stream-test".into(),
            rto_in_ms: 100,
            conn,
            vnet: None,
        })
        .await
        .unwrap();
        client.listen().await.unwrap();
        client
    }

    fn client_tls(
        cert: Option<rustls::pki_types::CertificateDer<'static>>,
    ) -> tokio_rustls::TlsConnector {
        let mut roots = rustls::RootCertStore::empty();
        if let Some(cert) = cert {
            roots.add(cert).unwrap();
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        tokio_rustls::TlsConnector::from(Arc::new(config))
    }

    #[tokio::test]
    async fn tcp_tls_relay_share_quotas_validate_certificates_and_release_on_disconnect() {
        timeout(Duration::from_secs(15), async {
            let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let tls = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let dir = std::env::temp_dir().join(format!("kantengyen-tls-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let signed = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
            let tls_config = TlsConfig {
                public_port: tls.local_addr().unwrap().port(),
                bind: match tls.local_addr().unwrap() {
                    SocketAddr::V4(a) => a,
                    _ => unreachable!(),
                },
                cert: dir.join("cert.pem"),
                key: dir.join("key.pem"),
            };
            std::fs::write(&tls_config.cert, signed.cert.pem()).unwrap();
            std::fs::write(&tls_config.key, signed.signing_key.serialize_pem()).unwrap();
            let config = Config {
                public_ip: "203.0.113.10".parse().unwrap(),
                public_host: "localhost".into(),
                bind: match udp.local_addr().unwrap() {
                    SocketAddr::V4(a) => a,
                    _ => unreachable!(),
                },
                tcp_bind: Some(match tcp.local_addr().unwrap() {
                    SocketAddr::V4(a) => a,
                    _ => unreachable!(),
                }),
                tcp_public_port: tcp.local_addr().unwrap().port(),
                tls: Some(tls_config.clone()),
                max_connections: 8,
                transport: "all".into(),
                relay_ip: Ipv4Addr::LOCALHOST,
                min_port: 49160,
                max_port: 49200,
                max_allocations: 2,
                bytes_per_second: 128000,
                secret: "s".repeat(64),
            };
            drop((udp, tcp, tls));
            let runtime = config.start().await.unwrap();
            let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
            assert!(
                client_tls(None)
                    .connect(
                        name.clone(),
                        tokio::net::TcpStream::connect(tls_config.bind)
                            .await
                            .unwrap()
                    )
                    .await
                    .is_err()
            );
            let tcp_io = tokio::net::TcpStream::connect(config.tcp_bind.unwrap())
                .await
                .unwrap();
            let a_conn = Arc::new(StreamConn::new(
                Box::new(tcp_io),
                "127.0.0.1:1".parse().unwrap(),
                config.tcp_bind.unwrap().into(),
                Arc::new(Ingress::new()),
            ));
            let tls_io = client_tls(Some(signed.cert.der().clone()))
                .connect(
                    name,
                    tokio::net::TcpStream::connect(tls_config.bind)
                        .await
                        .unwrap(),
                )
                .await
                .unwrap();
            let b_conn = Arc::new(StreamConn::new(
                Box::new(tls_io),
                "127.0.0.1:2".parse().unwrap(),
                tls_config.bind.into(),
                Arc::new(Ingress::new()),
            ));
            let a = client(&config, a_conn.clone()).await;
            let b = client(&config, b_conn.clone()).await;
            assert!(
                a.send_binding_request_to(config.tcp_bind.unwrap().to_string().as_str())
                    .await
                    .is_ok()
            );
            let ra = a.allocate().await.unwrap();
            let rb = b.allocate().await.unwrap();
            let (addr_a, addr_b) = (ra.local_addr().unwrap(), rb.local_addr().unwrap());
            rb.send_to(b"warmup", addr_a).await.unwrap();
            ra.send_to(b"tcp-to-tls", addr_b).await.unwrap();
            let mut buf = [0; 64];
            let (n, _) = rb.recv_from(&mut buf).await.unwrap();
            assert_eq!(&buf[..n], b"tcp-to-tls");
            rb.send_to(b"tls-to-tcp", addr_a).await.unwrap();
            loop {
                let (n, _) = ra.recv_from(&mut buf).await.unwrap();
                if &buf[..n] == b"tls-to-tcp" {
                    break;
                }
            }
            let c = client(
                &config,
                Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()),
            )
            .await;
            assert!(
                c.allocate().await.is_err(),
                "allocation limit is shared by UDP/TCP/TLS"
            );
            a_conn.close().await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let rc = c.allocate().await.unwrap();
            rc.close().await.unwrap();
            a.close().await.unwrap();
            b.close().await.unwrap();
            c.close().await.unwrap();
            b_conn.close().await.unwrap();
            runtime.close().await.unwrap();
            assert!(TcpListener::bind(config.tcp_bind.unwrap()).await.is_ok());
            assert!(TcpListener::bind(tls_config.bind).await.is_ok());
            // A bad replacement leaves the last valid certificate active.
            let mut certificates = Certificates::new(tls_config.clone()).unwrap();
            let old = certificates.current.read().unwrap().clone();
            std::fs::write(&tls_config.key, "invalid").unwrap();
            assert!(certificates.reload().is_err());
            assert!(Arc::ptr_eq(&old, &certificates.current.read().unwrap()));
            let next = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
            std::fs::write(&tls_config.cert, next.cert.pem()).unwrap();
            std::fs::write(&tls_config.key, next.signing_key.serialize_pem()).unwrap();
            certificates.reload().unwrap();
            assert!(!Arc::ptr_eq(&old, &certificates.current.read().unwrap()));
            std::fs::remove_file(tls_config.cert).unwrap();
            std::fs::remove_file(tls_config.key).unwrap();
            std::fs::remove_dir(dir).unwrap();
        })
        .await
        .expect("stream TURN test exceeded timeout");
    }

    #[tokio::test]
    async fn stream_framing_handles_fragmentation_coalescing_and_padding() {
        let (mut tx, mut rx) = tokio::io::duplex(128);
        let mut stun = vec![0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42];
        stun.resize(20, 0);
        let expected = stun.clone();
        tokio::spawn(async move {
            for byte in [0x40, 1, 0, 1, 42, 0, 0, 0] {
                tx.write_all(&[byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
            tx.write_all(&[stun.clone(), stun].concat()).await.unwrap();
        });
        let mut buf = [0; 1500];
        assert_eq!(read_frame(&mut rx, &mut buf).await.unwrap(), 5);
        assert_eq!(buf[4], 42);
        for _ in 0..2 {
            assert_eq!(read_frame(&mut rx, &mut buf).await.unwrap(), 20);
            assert_eq!(&buf[..20], &expected);
        }
        assert!(read_frame(&mut rx, &mut buf).await.is_err());
        for invalid in [
            vec![0, 1, 0xff, 0xfc],
            vec![0x80, 0, 0, 0],
            vec![0, 1, 0, 1],
        ] {
            assert!(read_frame(&mut invalid.as_slice(), &mut buf).await.is_err());
        }
    }
}
