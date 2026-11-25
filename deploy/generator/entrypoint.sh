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
  if ! git diff --cached --quiet; then
    git commit -m "update $(date '+%F %T')" -q || true
  fi

  # 先同步远端再推送，避免历史分叉导致非快进被拒。
  # 旧版用 `|| true` 吞掉推送错误并照打“已推送”，曾静默失联 3 周。
  if GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/id_ed25519" git fetch -q origin main 2>/dev/null; then
    if ! GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/id_ed25519" git rebase -q origin/main 2>/dev/null; then
      git rebase --abort 2>/dev/null || true
      echo "[push] 检测到历史分叉，重置到 origin/main 后重新生成"
      git reset -q --hard origin/main || true
      node /app/generate.mjs --out /app/output || true
      git add -A
      if ! git diff --cached --quiet; then
        git commit -m "update $(date '+%F %T')" -q || true
      fi
    fi
  else
    echo "[push] WARN: git fetch 失败，跳过本次推送（本地提交保留）"
    return 0
  fi

  if git diff --quiet origin/main HEAD 2>/dev/null; then
    echo "[push] 与远端一致，跳过"
    return 0
  fi

  if GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/id_ed25519" git push -q origin HEAD:main; then
    echo "[push] 已推送 $(git rev-parse --short HEAD)"
  elif GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /root/.ssh/router_ed25519" git push -q origin HEAD:main; then
    echo "[push] 已推送(备用密钥) $(git rev-parse --short HEAD)"
  else
    echo "[push] FAILED：本次提交未推送（本地已保留），请检查 SSH/网络/远端保护"
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
