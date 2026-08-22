#!/bin/sh
# 启动 HTTP 服务 + 定时生成 + 推送到私有仓库
set -e
INTERVAL="${GENERATE_INTERVAL:-21600}"

push_to_github() {
  cd /app/output
  git init -q 2>/dev/null || true
  git remote remove origin 2>/dev/null || true
  git remote add origin "${PUSH_REPO:-git@github.com:archzhjam/clash-configs.git}" 2>/dev/null || true
  git add -A
  if git diff --cached --quiet; then
    echo "[push] 无变化，跳过"
  else
    git commit -m "update $(date '+%F %T')" -q
    GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/id_ed25519" git push -q origin HEAD:main || \
      GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/router_ed25519" git push -q origin HEAD:main || true
    echo "[push] 已推送"
  fi
}

echo "[entry] 启动 HTTP 服务并首次生成..."
node /app/generate.mjs --out /app/output --serve &
echo "[entry] 首次推送..."
push_to_github

while true; do
  sleep "$INTERVAL"
  echo "[entry] 定时生成 ($(date '+%F %T'))..."
  node /app/generate.mjs --out /app/output
  push_to_github
done
