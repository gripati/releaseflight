#!/usr/bin/env bash
# GamePublisher — one-shot local setup
# Usage: ./scripts/setup.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. .env
if [[ ! -f .env ]]; then
  cp .env.example .env
  # Generate a per-installation session secret
  SECRET=$(openssl rand -base64 48 | tr -d '=' | tr '+/' '-_')
  sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env && rm .env.bak
  echo "✓ .env created (SESSION_SECRET generated)"
else
  echo "• .env already exists"
fi

# 2. Storage dirs
mkdir -p data/secrets data/storage scratch
chmod 700 data/secrets
echo "✓ data/ directories ready"

# 3. Docker stack
echo "→ Starting Docker stack…"
docker compose up -d
echo "✓ postgres + redis + minio + mailhog up"

# 4. Wait for postgres
echo -n "→ Waiting for postgres…"
until docker compose exec -T postgres pg_isready -U gp -d gamepublisher > /dev/null 2>&1; do
  sleep 1
  echo -n "."
done
echo " ready"

# 5. pnpm install
if [[ ! -d node_modules ]]; then
  echo "→ Installing dependencies via pnpm…"
  pnpm install
fi

# 6. Prisma generate + migrate + seed
echo "→ Running Prisma generate + migrate + seed…"
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ GamePublisher is ready."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Run the dev server:"
echo "    pnpm dev"
echo ""
echo "  Then open:"
echo "    http://localhost:3000/login"
echo ""
echo "  Sign in with the credentials from .env:"
echo "    Email:    \$SELF_HOST_OWNER_EMAIL"
echo "    Password: \$SELF_HOST_OWNER_PASSWORD"
echo ""
