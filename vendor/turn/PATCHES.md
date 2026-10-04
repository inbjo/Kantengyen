# turn 0.17.2

Source: https://static.crates.io/crates/turn/turn-0.17.2.crate
Upstream: https://github.com/webrtc-rs/webrtc

The library source and MIT/Apache-2.0 licenses are retained. Examples and
benchmark assets are omitted from this source distribution.

Local change: `src/server/request.rs` prunes expired authentication nonces
before issuing a challenge and limits the cache to 4096 entries, evicting the
oldest nonce at capacity. Evicted clients can obtain a fresh challenge. This
prevents unauthenticated requests from growing the cache indefinitely.

Socket rate limits, allocation limits, relay port selection, peer filtering,
bandwidth limits and temporary credential validation are implemented in
`crates/server/src/embedded_turn.rs` outside the vendored library.
