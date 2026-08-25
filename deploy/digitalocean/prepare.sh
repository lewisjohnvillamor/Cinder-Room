#!/bin/sh
set -eu

if [ -f .env ]; then
  echo ".env already exists. Move it aside before generating a new deployment identity."
  exit 1
fi

printf "Cinder domain (for example room.example.com): "
read -r cinder_domain
printf "Media domain (for example media.example.com): "
read -r media_domain

if [ -z "$cinder_domain" ] || [ -z "$media_domain" ]; then
  echo "Both domains are required."
  exit 1
fi

umask 077
api_key="cinder_$(openssl rand -hex 12)"
api_secret="$(openssl rand -base64 36 | tr -d '\n=/+' | cut -c1-43)"

cat > .env <<EOF
CINDER_DOMAIN=$cinder_domain
MEDIA_DOMAIN=$media_domain
LIVEKIT_API_KEY=$api_key
LIVEKIT_API_SECRET=$api_secret
MAX_PARTICIPANTS=12
MAX_FILE_MB=25
MAX_CONCURRENT_UPLOADS=2
MAX_ROOM_STORAGE_MB=256
EOF

echo "Created a private .env with locally generated media credentials."
echo "Point both DNS names to this Droplet, then run: docker compose up -d --build"
