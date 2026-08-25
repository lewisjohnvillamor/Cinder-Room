FROM node:22.13-bookworm-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY components ./components
COPY app/globals.css ./app/globals.css
RUN npm run build:room-ui

FROM rust:1.89-bookworm AS relay
WORKDIR /app
COPY rust-server ./rust-server
RUN cargo build --release --manifest-path rust-server/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tor && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=relay /app/rust-server/target/release/cinder-room-relay /usr/local/bin/cinder-room-relay
COPY --from=ui /app/self-host-dist ./self-host-dist
ENV PORT=3000 CINDER_BIND=0.0.0.0 CINDER_ROUTES=tor
EXPOSE 3000
USER debian-tor
CMD ["cinder-room-relay"]
