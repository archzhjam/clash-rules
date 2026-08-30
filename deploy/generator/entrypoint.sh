#!/bin/sh
# 启动 HTTP 服务 + 定时生成 + 推送到私有仓库
set -e
INTERVAL="${GENERATE_INTERVAL:-21600}"

# 挂载卷属主与容器内用户不一致时，git 2.35.2+ 会拒绝操作（dubious ownership）
git config --global --add safe.directory /app/output || true
git config --global --add safe.directory /app || true

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

echo "[entry] 首次生成（前台完成，避免与推送竞态）..."
node /app/generate.mjs --out /app/output
echo "[entry] 启动 HTTP 服务..."
node /app/generate.mjs --out /app/output --serve-only &
echo "[entry] 首次推送..."
push_to_github

while true; do
  sleep "$INTERVAL"
  echo "[entry] 定时生成 ($(date '+%F %T'))..."
  node /app/generate.mjs --out /app/output
  push_to_github
done
