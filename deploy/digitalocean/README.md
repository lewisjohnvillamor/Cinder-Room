# DigitalOcean quick deployment

This bundle runs Cinder, LiveKit, embedded TURN/UDP, and automatic HTTPS on one owner-operated Droplet. No LiveKit Cloud account is used. Room ciphertext is stored in a temporary in-memory filesystem and disappears when the Cinder container stops; Caddy retains only its TLS material.

## Recommended starting size

- **1 shared vCPU / 1 GB RAM:** evaluation, chat/files, and roughly 2–4 active cameras at modest quality.
- **1–2 vCPU / 2 GB RAM:** safer starting point for regular small-room use and up to Cinder's six-camera UI limit.

These are conservative starting estimates, not guaranteed capacity. Video load is driven mostly by active publishers, subscribers, resolution, and outbound bandwidth. Monitor CPU, memory, packet loss, and transfer, then resize the Droplet if needed.

A 1 GB Droplet may run the small-room stack but run out of memory while compiling the Docker image. Either build elsewhere and transfer the image or add a temporary 2 GB swap file before `docker compose up --build`:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

Confirm it with `swapon --show`. Remove it later only after stopping the stack and confirming runtime memory is stable.

## 1. Create the server

Create an Ubuntu 24.04 Droplet with SSH-key authentication. Choose a region close to the expected participants. Enable DigitalOcean monitoring. Backups are optional because Cinder deliberately has no persistent room history.

DigitalOcean signup/referral: <https://m.do.co/c/2b70ddbc175d>

## 2. Point two DNS names at the Droplet

Create two `A` records using the Droplet's public IPv4 address:

- `room.example.com` — Cinder chat, files, and invitations.
- `media.example.com` — LiveKit secure WebSocket signaling.

Caddy requests trusted TLS certificates automatically after both records resolve to the Droplet.

## 3. Add a DigitalOcean Cloud Firewall

Allow these inbound rules and leave outbound traffic allowed:

| Protocol | Port | Source | Purpose |
| --- | ---: | --- | --- |
| TCP | `22` | Your administrator IP | SSH administration |
| TCP | `80` | All IPv4/IPv6 | Automatic TLS issuance and redirect |
| TCP | `443` | All IPv4/IPv6 | Cinder HTTPS and LiveKit WSS |
| TCP | `7881` | All IPv4/IPv6 | WebRTC TCP fallback |
| UDP | `3478` | All IPv4/IPv6 | Embedded TURN/UDP |
| UDP | `50000-60000` | All IPv4/IPv6 | WebRTC media |

Do not expose Cinder's internal port `3000` or LiveKit signaling port `7880`; Caddy reaches both through loopback.

## 4. Install and start

Install Git, Docker Engine, the Compose plugin, and OpenSSL using their official Ubuntu instructions. Clone or copy Cinder onto the Droplet, then run:

```bash
cd cinder-room/deploy/digitalocean
chmod +x prepare.sh
./prepare.sh
docker compose up -d --build
```

`prepare.sh` asks for the two domains and creates a private `.env` with a random LiveKit key and secret. The secret is never placed in the repository or sent to a hosted media provider.

Open `https://room.example.com`, replacing the hostname with yours. The first browser creates the host capability link. Use **Invite** to copy the guest link.

## Operate the room

```bash
docker compose ps
docker compose logs --tail=100 cinder livekit caddy
docker compose restart
docker compose down
```

`docker compose down` stops the room and removes its temporary ciphertext. It intentionally preserves the Caddy certificate volume and the local `.env`. To rotate the media server identity, stop the deployment, move `.env` aside, run `./prepare.sh` again, and start it.

Update container images during a maintenance window:

```bash
docker compose pull
docker compose up -d --build
```

For reproducible production operations, replace `latest`/major image tags with versions you have tested before updating.

## Important limits

- A small Droplet is for small rooms, not the configured 50-user relay ceiling.
- Mobile browsers can join camera/microphone calls and watch presentations. Starting a screen share depends on the mobile operating system and browser; desktop Chromium remains the most reliable presenter.
- TURN prevents participants from connecting directly to one another, but the owner-operated VPS still sees network addresses and traffic metadata.
- The public media route is separate from Tor. Use the Onion/Cloudflare paths for chat and files when stronger network privacy matters more than interactive video latency.

Reference documentation: [DigitalOcean production Droplet setup](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/), [DigitalOcean Cloud Firewalls](https://docs.digitalocean.com/products/networking/firewalls/), [LiveKit VM deployment](https://docs.livekit.io/transport/self-hosting/vm/), and [LiveKit ports/firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/).
