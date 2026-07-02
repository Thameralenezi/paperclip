#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Auto-discover container IP so ALB health checks pass the hostname guard.
# ALB sends Host: <target-ip> which isn't in PAPERCLIP_ALLOWED_HOSTNAMES by default.
CONTAINER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$CONTAINER_IP" ] && [ -n "$PAPERCLIP_ALLOWED_HOSTNAMES" ]; then
  export PAPERCLIP_ALLOWED_HOSTNAMES="${PAPERCLIP_ALLOWED_HOSTNAMES},${CONTAINER_IP}"
fi

# ─── Agent workspace bootstrap ──────────────────────────────────────────────
# Ensure the Qiyas repo is available for claude_local / kimi_code agents.
# This runs as root before dropping to the node user so it can fix ownership.
WORKSPACE_DIR="/paperclip/workspaces/qiyas"
REPO_URL="https://github.com/Thameralenezi/Project-for-Qyias-Platfrom.git"

mkdir -p "$WORKSPACE_DIR"

# Avoid "dubious ownership" errors when the repo was cloned by a different UID
# (e.g., a one-off ECS task or host bind mount).
git config --system --add safe.directory "$WORKSPACE_DIR" 2>/dev/null || true

bootstrap_repo() {
  if [ ! -d "$WORKSPACE_DIR/.git" ]; then
    echo "[workspace-bootstrap] Cloning Qiyas repo into $WORKSPACE_DIR ..."
    # Shallow clone keeps startup fast; agents can deepen later if needed.
    git clone --depth 1 "$REPO_URL" "$WORKSPACE_DIR" || {
      echo "[workspace-bootstrap] WARNING: clone failed; agents may need to retry."
      return 0
    }
  fi

  cd "$WORKSPACE_DIR" || return 0

  # Ensure the origin remote points to the expected URL.
  if ! git remote get-url origin >/dev/null 2>&1; then
    git remote add origin "$REPO_URL" || true
  fi

  # Make sure fetch creates remote-tracking refs (origin/main, origin/master, etc.)
  git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*" 2>/dev/null || true

  echo "[workspace-bootstrap] Fetching latest refs ..."
  git fetch origin || {
    echo "[workspace-bootstrap] WARNING: fetch failed; leaving workspace as-is."
    return 0
  }

  # Determine which default branch is available on the remote.
  branch=""
  for candidate in main master; do
    if git show-ref --verify --quiet "refs/remotes/origin/${candidate}"; then
      branch="$candidate"
      break
    fi
  done

  if [ -z "$branch" ]; then
    echo "[workspace-bootstrap] WARNING: no origin/main or origin/master found; leaving workspace as-is."
    return 0
  fi

  echo "[workspace-bootstrap] Checking out origin/${branch} ..."
  git checkout -B "$branch" "origin/${branch}" || {
    echo "[workspace-bootstrap] WARNING: checkout of origin/${branch} failed; leaving workspace as-is."
    return 0
  }

  echo "[workspace-bootstrap] Pulling latest ${branch} ..."
  git pull origin "$branch" || {
    echo "[workspace-bootstrap] WARNING: pull failed; workspace may be behind."
    return 0
  }

  echo "[workspace-bootstrap] Workspace ready on branch: ${branch}"
}

# Run bootstrap in a subshell so the git commands cannot change the
# entrypoint's working directory (the Paperclip server must start from /app).
( bootstrap_repo )

chown -R node:node /paperclip/workspaces || true

exec gosu node "$@"
