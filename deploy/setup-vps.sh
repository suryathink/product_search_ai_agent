#!/usr/bin/env bash
# ONE-TIME setup of the VPS for this app (safe to re-run). After this, GitHub Actions deploys on every push.
# Coexists with other apps on the same server: only adds its own nginx sites, folders and container.
#
# Copy the deploy/ folder to the server, then run it there:
#   scp -r deploy <user>@<server-ip>:/tmp/product-agent-deploy
#   ssh <user>@<server-ip> "sudo bash /tmp/product-agent-deploy/setup-vps.sh bosch-agent.api.suryathink.com bosch-agent.suryathink.com you@example.com <deploy-user>"
#
# Prerequisites: DNS A records for both domains point to this server.
set -euo pipefail

API_DOMAIN="${1:?usage: setup-vps.sh <api-domain> <app-domain> <email> <deploy-user>}"
APP_DOMAIN="${2:?usage: setup-vps.sh <api-domain> <app-domain> <email> <deploy-user>}"
EMAIL="${3:?usage: setup-vps.sh <api-domain> <app-domain> <email> <deploy-user>}"
DEPLOY_USER="${4:?usage: setup-vps.sh <api-domain> <app-domain> <email> <deploy-user>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_DIR="/opt/product-agent"
WEB_BASE="/var/www/${APP_DOMAIN}"

step() { echo -e "\n\033[1;34m==> $*\033[0m"; }
fail() { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "run with sudo"
id "$DEPLOY_USER" >/dev/null 2>&1 || fail "user '$DEPLOY_USER' does not exist on this server"

step "1/6 Packages (skips anything already installed)"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl dnsutils
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
# The deploy user runs `docker pull/run` over SSH from GitHub Actions
[[ "$DEPLOY_USER" == "root" ]] || usermod -aG docker "$DEPLOY_USER"

step "2/6 DNS check (Let's Encrypt needs both names to point here)"
SERVER_IP="$(curl -fsS https://api.ipify.org || true)"
for host in "$API_DOMAIN" "$APP_DOMAIN"; do
  resolved="$(dig +short "$host" A | tail -n1)"
  echo "  $host -> ${resolved:-<nothing>}   (this server: ${SERVER_IP:-unknown})"
  [[ -n "$resolved" ]] || fail "$host has no A record yet — add it at Hostinger and wait a few minutes"
  [[ -z "$SERVER_IP" || "$resolved" == "$SERVER_IP" ]] || fail "$host points to $resolved, not this server ($SERVER_IP)"
done

step "Port check (this app uses 3001 on 127.0.0.1 — same as local development)"
echo "  Ports currently listening on this server:"
ss -ltnpH | awk '{print "    " $4 "  " $6}' | sort -u
# 3001 must be free, or already held by THIS app's container (re-run of the script)
if ss -ltnH "( sport = :3001 )" | grep -q .; then
  if docker ps --format '{{.Names}}' | grep -qx product-agent-server; then
    echo "  3001 is used by product-agent-server (this app) — OK"
  else
    fail "port 3001 is already used by another process (see list above). Free it, or change 3001 in deploy-server.sh, nginx/api.conf.template and backend PORT together."
  fi
else
  echo "  3001 is free — OK"
fi

step "3/6 Folders"
mkdir -p "$ENV_DIR" "${WEB_BASE}/releases"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$WEB_BASE"        # deploy-client.sh writes releases here
chmod 700 "$ENV_DIR"
if [[ ! -f "$ENV_DIR/server.env" ]]; then
  echo "  NOTE: $ENV_DIR/server.env does not exist yet — create it before the first backend deploy (see deploy/DEPLOY.md)"
fi
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$ENV_DIR"

step "4/6 Placeholder page until the first frontend deploy"
if [[ ! -e "${WEB_BASE}/current" ]]; then
  mkdir -p "${WEB_BASE}/releases/placeholder"
  echo "<h1>Deploying…</h1>" > "${WEB_BASE}/releases/placeholder/index.html"
  ln -sfn "${WEB_BASE}/releases/placeholder" "${WEB_BASE}/current"
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$WEB_BASE"
fi

step "5/6 nginx sites (only this app's two sites are added)"
sed "s/__API_DOMAIN__/${API_DOMAIN}/g" "$HERE/nginx/api.conf.template" > "/etc/nginx/sites-available/${API_DOMAIN}"
sed "s/__APP_DOMAIN__/${APP_DOMAIN}/g" "$HERE/nginx/app.conf.template" > "/etc/nginx/sites-available/${APP_DOMAIN}"
ln -sf "/etc/nginx/sites-available/${API_DOMAIN}" "/etc/nginx/sites-enabled/${API_DOMAIN}"
ln -sf "/etc/nginx/sites-available/${APP_DOMAIN}" "/etc/nginx/sites-enabled/${APP_DOMAIN}"
nginx -t
systemctl reload nginx
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null
fi

step "6/6 HTTPS certificates (Let's Encrypt, auto-renewing)"
certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$API_DOMAIN" -d "$APP_DOMAIN"

echo -e "\n\033[1;32mServer ready.\033[0m Next: create $ENV_DIR/server.env (if not done), add the GitHub secrets/variables,"
echo "then push to main or run both workflows from the Actions tab."
