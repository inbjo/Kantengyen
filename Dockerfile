FROM rust:1.96.1-bookworm AS wasm
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY vendor ./vendor
RUN rustup target add wasm32-unknown-unknown && cargo build --locked --release -p kantengyen-core --target wasm32-unknown-unknown

FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci --ignore-scripts
COPY web ./web
COPY --from=wasm /app/target/wasm32-unknown-unknown/release/kantengyen_core.wasm ./web/public/rules.wasm
RUN npm run build --workspace web

FROM wasm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl
COPY --from=frontend /app/web/dist ./web/dist
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
ENV RUSTFLAGS="-C target-feature=+crt-static"
RUN cargo build --locked --release -p kantengyen-server --target x86_64-unknown-linux-musl
RUN readelf -h target/x86_64-unknown-linux-musl/release/kantengyen-server
RUN ! readelf -l target/x86_64-unknown-linux-musl/release/kantengyen-server | grep -q INTERP
RUN ! readelf -d target/x86_64-unknown-linux-musl/release/kantengyen-server | grep -q NEEDED

FROM scratch AS artifact
COPY --from=backend /app/target/x86_64-unknown-linux-musl/release/kantengyen-server /kantengyen-server
COPY LICENSE THIRD_PARTY_NOTICES.md /
COPY licenses /licenses/

FROM artifact AS runtime
ENV BIND_ADDR=0.0.0.0:3000
USER 10001:10001
EXPOSE 3000
EXPOSE 3478/udp
EXPOSE 49160-49200/udp
CMD ["/kantengyen-server"]
