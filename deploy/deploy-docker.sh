#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="kumpeapps-github-bot"
DEFAULT_IMAGE="ghcr.io/kumpeapps/kumpeapps-github-bot:latest"
DEFAULT_INSTALL_DIR="/opt/kumpeapps-github-bot"
DEFAULT_BOT_PORT="3197"
ENV_FILE_NAME=".env"
COMPOSE_FILE_NAME="docker-compose.yml"
SYSTEMD_FILE="/etc/systemd/system/${APP_NAME}.service"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    ${SUDO} -v
  else
    echo "This installer needs root privileges. Re-run as root or install sudo."
    exit 1
  fi
fi

trap 'echo "Deployment failed on line ${LINENO}."' ERR

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local value

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    echo "${value:-$default_value}"
  else
    read -r -p "$label: " value
    echo "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local value
  read -r -s -p "$label: " value
  echo
  echo "$value"
}

prompt_yes_no() {
  local label="$1"
  local default_answer="${2:-y}"
  local answer

  while true; do
    if [[ "$default_answer" == "y" ]]; then
      read -r -p "$label [Y/n]: " answer
      answer="${answer:-y}"
    else
      read -r -p "$label [y/N]: " answer
      answer="${answer:-n}"
    fi

    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

validate_nonempty() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "$name is required."
    exit 1
  fi
}

escape_newlines() {
  sed ':a;N;$!ba;s/\n/\\n/g'
}

install_docker_engine() {
  if command -v docker >/dev/null 2>&1; then
    echo "Docker already installed."
  else
    echo "Installing Docker Engine and Compose plugin..."
    ${SUDO} apt update
    ${SUDO} apt install -y ca-certificates curl gnupg
    ${SUDO} install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null

    ${SUDO} apt update
    ${SUDO} apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  ${SUDO} systemctl enable --now docker
}

read_private_key() {
  local mode
  local key_file
  local key_content
  local line

  echo
  echo "Step 2: Configure GitHub App private key input"
  echo "(This is separate from the webhook secret.)"
  echo "  1) Path to PEM file"
  echo "  2) Paste PEM content"

  while true; do
    read -r -p "Private key input mode (1=PEM file path, 2=paste key) [1]: " mode
    mode="${mode:-1}"

    if [[ "$mode" == "1" ]]; then
      key_file="$(prompt "Path to private key PEM file")"
      validate_nonempty "Private key file path" "$key_file"
      if [[ ! -f "$key_file" ]]; then
        echo "File not found: $key_file"
        continue
      fi
      key_content="$(cat "$key_file")"
      break
    elif [[ "$mode" == "2" ]]; then
      echo "Paste the private key content, then type EOF on a new line:"
      key_content=""
      while IFS= read -r line; do
        if [[ "$line" == "EOF" ]]; then
          break
        fi
        key_content+="$line"
        key_content+=$'\n'
      done
      key_content="${key_content%$'\n'}"
      if [[ -z "$key_content" ]]; then
        echo "Private key content cannot be empty."
        continue
      fi
      break
    else
      echo "Please enter 1 or 2."
    fi
  done

  printf "%s" "$key_content"
}

write_compose_file() {
  local install_dir="$1"
  local image="$2"
  local bot_port="$3"

  cat >"${install_dir}/${COMPOSE_FILE_NAME}" <<EOF
services:
  ${APP_NAME}:
    image: ${image}
    pull_policy: always
    container_name: ${APP_NAME}
    restart: unless-stopped
    env_file:
      - ${ENV_FILE_NAME}
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3197
    ports:
      - "${bot_port}:3197"
EOF
}

write_env_file() {
  local install_dir="$1"
  local app_id="$2"
  local webhook_secret="$3"
  local private_key_escaped="$4"

  cat >"${install_dir}/${ENV_FILE_NAME}" <<EOF
APP_ID=${app_id}
PRIVATE_KEY="${private_key_escaped}"
WEBHOOK_SECRET=${webhook_secret}
HOST=0.0.0.0
PORT=3197
SECURITY_GATES_ENABLED=true
SECURITY_GATE_MIN_SEVERITY=high
SECRET_SCANNING_GATES_ENABLED=true
EOF

  chmod 600 "${install_dir}/${ENV_FILE_NAME}"
}

ghcr_login_if_requested() {
  if ! prompt_yes_no "Is your GHCR image public (skip docker login)?" "y"; then
    local ghcr_user
    local ghcr_token

    ghcr_user="$(prompt "GHCR GitHub username (not email)")"
    ghcr_token="$(prompt_secret "GHCR token (read:packages)")"
    validate_nonempty "GHCR username" "$ghcr_user"
    validate_nonempty "GHCR token" "$ghcr_token"

    printf "%s" "$ghcr_token" | ${SUDO} docker login ghcr.io -u "$ghcr_user" --password-stdin
  fi
}

run_compose_preflight() {
  local install_dir="$1"

  echo "Running docker compose preflight checks..."
  ${SUDO} docker compose -f "${install_dir}/${COMPOSE_FILE_NAME}" --env-file "${install_dir}/${ENV_FILE_NAME}" config >/dev/null
  ${SUDO} docker compose -f "${install_dir}/${COMPOSE_FILE_NAME}" --env-file "${install_dir}/${ENV_FILE_NAME}" pull
}

write_systemd_unit() {
  local install_dir="$1"
  local docker_bin

  docker_bin="$(command -v docker || true)"
  validate_nonempty "docker binary path" "$docker_bin"

  ${SUDO} tee "$SYSTEMD_FILE" >/dev/null <<EOF
[Unit]
Description=KumpeApps GitHub Bot (Docker Compose)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${install_dir}
ExecStart=${docker_bin} compose pull
ExecStart=${docker_bin} compose up -d --remove-orphans
ExecStop=${docker_bin} compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

  ${SUDO} systemctl daemon-reload
  if ! ${SUDO} systemctl enable --now "${APP_NAME}.service"; then
    echo
    echo "Service failed to start. Diagnostics:"
    ${SUDO} systemctl --no-pager --full status "${APP_NAME}.service" || true
    ${SUDO} journalctl --no-pager -u "${APP_NAME}.service" -n 80 || true
    exit 1
  fi
}

main() {
  if ! command -v apt >/dev/null 2>&1; then
    echo "This script currently supports Debian/Ubuntu style apt systems."
    exit 1
  fi

  local install_dir
  local image
  local bot_port
  local app_id
  local webhook_secret
  local private_key_raw
  local private_key_escaped

  echo "==============================================="
  echo "KumpeApps GitHub Bot - Docker Host Deploy"
  echo "==============================================="
  echo

  install_dir="$(prompt "Install directory" "$DEFAULT_INSTALL_DIR")"
  image="$(prompt "Container image" "$DEFAULT_IMAGE")"
  bot_port="$(prompt "Host port for bot/WAF upstream" "$DEFAULT_BOT_PORT")"
  app_id="$(prompt "GitHub App ID")"
  echo
  echo "Step 1: Enter GitHub webhook secret"
  webhook_secret="$(prompt_secret "GitHub Webhook Secret (from GitHub App settings)")"

  validate_nonempty "Install directory" "$install_dir"
  validate_nonempty "Container image" "$image"
  validate_nonempty "Host port" "$bot_port"
  validate_nonempty "APP_ID" "$app_id"
  validate_nonempty "WEBHOOK_SECRET" "$webhook_secret"

  if ! [[ "$bot_port" =~ ^[0-9]+$ ]] || (( bot_port < 1 || bot_port > 65535 )); then
    echo "Host port must be a number between 1 and 65535."
    exit 1
  fi

  echo
  private_key_raw="$(read_private_key)"
  private_key_escaped="$(printf "%s" "$private_key_raw" | escape_newlines)"

  if prompt_yes_no "Install/upgrade Docker Engine and Docker Compose plugin?" "y"; then
    install_docker_engine
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker not found. Install Docker first or rerun and allow automatic install."
    exit 1
  fi

  ${SUDO} mkdir -p "$install_dir"
  ${SUDO} chown -R "$(id -un):$(id -gn)" "$install_dir"

  write_compose_file "$install_dir" "$image" "$bot_port"
  write_env_file "$install_dir" "$app_id" "$webhook_secret" "$private_key_escaped"

  ghcr_login_if_requested
  run_compose_preflight "$install_dir"

  write_systemd_unit "$install_dir"

  echo
  echo "Deployment completed."
  echo "Service: ${APP_NAME}.service"
  echo "Working directory: ${install_dir}"
  echo "Container image: ${image}"
  echo "Webhook URL (typical): https://YOUR_PUBLIC_DOMAIN:${bot_port}/api/github/webhooks"
  echo
  ${SUDO} systemctl --no-pager --full status "${APP_NAME}.service" || true
}

main "$@"
