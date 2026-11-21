#!/usr/bin/env bash
# =========================================
# WINTEK SOLUTIONS
# Install the relay web app as a systemd service
# =========================================
#
# Usage (run from anywhere, as a normal user with sudo rights):
#   ./install-service.sh            install / update and start the service
#   ./install-service.sh uninstall  stop and remove the service
#
# After installing:
#   sudo systemctl status relay-webapp     is it running?
#   sudo journalctl -u relay-webapp -f     live log
#   sudo systemctl restart relay-webapp    after editing .env or pulling new code

set -euo pipefail

SERVICE=relay-webapp
UNIT_FILE=/etc/systemd/system/$SERVICE.service
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

if [[ "${1:-}" == "uninstall" ]]; then
  echo "Removing $SERVICE service..."
  sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
  sudo rm -f "$UNIT_FILE"
  sudo systemctl daemon-reload
  echo "Done. The app files in $APP_DIR were not touched."
  exit 0
fi

# --- checks ---------------------------------------------------------------

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found. Install it first, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  exit 1
fi

if [[ ! -f "$APP_DIR/server.js" ]]; then
  echo "ERROR: server.js not found in $APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "No .env found - creating one from .env.example"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo
  echo ">>> Edit $APP_DIR/.env and set APP_PASSWORD, then run this script again."
  exit 1
fi

if ! grep -qE '^APP_PASSWORD=.' "$APP_DIR/.env" \
   || grep -qE '^APP_PASSWORD=["'"'"']?(change-me)?["'"'"']?\s*$' "$APP_DIR/.env"; then
  echo "ERROR: APP_PASSWORD in $APP_DIR/.env is empty or still 'change-me'."
  echo "Set a real password first: nano $APP_DIR/.env"
  exit 1
fi

chmod 600 "$APP_DIR/.env"

WEB_PORT="$(grep -E '^WEB_PORT=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2 | tr -d "\"' \r" || true)"
WEB_PORT="${WEB_PORT:-8080}"

# Ports below 1024 (e.g. 80) need an extra permission for a non-root user
EXTRA_CAPS=""
if (( WEB_PORT < 1024 )); then
  EXTRA_CAPS="AmbientCapabilities=CAP_NET_BIND_SERVICE"
fi

# --- write the unit file --------------------------------------------------

echo "Installing $SERVICE"
echo "  app dir : $APP_DIR"
echo "  user    : $RUN_USER"
echo "  node    : $NODE_BIN ($("$NODE_BIN" -v))"
echo "  port    : $WEB_PORT"

sudo tee "$UNIT_FILE" >/dev/null <<EOF
[Unit]
Description=Wintek relay web app (EC200U GPIO2 control)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
$EXTRA_CAPS

# Basic hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo
  echo "Service is running. It will also start automatically after a reboot."
  echo "Open: http://<server-ip>:$WEB_PORT  (user: admin)"
  echo
  sudo journalctl -u "$SERVICE" -n 6 --no-pager
else
  echo
  echo "ERROR: service failed to start. Last log lines:"
  sudo journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi

if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  if ! sudo ufw status | grep -qE "^$WEB_PORT(/tcp)?\s"; then
    echo
    echo "Note: the ufw firewall is on and port $WEB_PORT is not open. To open it:"
    echo "  sudo ufw allow $WEB_PORT/tcp"
  fi
fi
