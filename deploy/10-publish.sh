#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 2：本机工作副本 → /opt/PanWatch/app
#
#  用法：bash deploy/10-publish.sh
#
#  为什么用 tar 不用 rsync：本机（Hermes 容器）没有 rsync 可执行文件，
#  且容器内无 sudo 装不了；服务器端有 rsync 但推不过去。
#  tar 走 ssh 管道效果等价。
#
#  同步内容：
#    后端源码 + 前端源码（= 用户要的「源文件」）
#    frontend/dist  →  /opt/PanWatch/app/static/（前端产物）
#  不同步：.git（服务器只运行不开发）、node_modules、.venv、
#          __pycache__、data（数据目录独立管理，避免被覆盖）
#
#  每次都是「清空 app/ 再铺」——保证服务器 == 本机构建产物，
#  不会残留上一次删掉的文件。
# ============================================================
set -euo pipefail

LOCAL=/opt/data/panwatch
REMOTE=ubuntu@110.42.222.4
KEY=/opt/data/home/.ssh/id_ed25519_stockcloud
APP=/opt/PanWatch/app
SSHOPTS="-i $KEY -o StrictHostKeyChecking=accept-new"

EXCLUDES=(
  --exclude='./.git' --exclude='./.github' --exclude='./.venv'
  --exclude='./.pytest_cache' --exclude='./.agents'
  --exclude='./frontend/node_modules' --exclude='./frontend/dist'
  --exclude='./frontend/.vite' --exclude='./frontend/tsconfig.tsbuildinfo'
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.egg-info'
  --exclude='./data' --exclude='./.env'
)

echo "=== 1. 清空远端 app/（保留 data）==="
# 必须保留 app/data：上游把数据库路径硬编码成「源码目录/data/panwatch.db」
# （src/platform/persistence/database.py），所以数据目录得挂在源码树里；
# 但真正的文件放在 /opt/PanWatch/data，app/data 只是个符号链接。
# 用 find 而不是 `rm -rf $APP/*`，否则每次发布都会把数据库删掉。
ssh $SSHOPTS $REMOTE "find $APP -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null; mkdir -p $APP/static"

echo "=== 2. 铺源码 ==="
tar czf - "${EXCLUDES[@]}" -C "$LOCAL" . \
  | ssh $SSHOPTS $REMOTE "tar xzf - -C $APP"

echo "=== 3. 前端产物 → app/static ==="
tar czf - -C "$LOCAL/frontend/dist" . \
  | ssh $SSHOPTS $REMOTE "tar xzf - -C $APP/static"

# === 3.5 写构建信息（分析页筛选行右端的「代码版本 / 提交时间」） ===
# 服务器上没有 .git（上一步的 exclude 里有），后端 fork_market.build_info() 三级回退里
# 第一级就是读这个文件。缺了它那行只剩「同步」时间，不会报错。
GIT_SHA=$(git -C "$LOCAL" rev-parse --short=8 HEAD)
GIT_BRANCH=$(git -C "$LOCAL" rev-parse --abbrev-ref HEAD)
GIT_COMMIT_TIME=$(git -C "$LOCAL" log -1 --format=%cI)
PUBLISHED_AT=$(date -Iseconds)
echo "=== 3.5 构建信息：${GIT_BRANCH} @ ${GIT_SHA} (${GIT_COMMIT_TIME}) ==="
printf '{"sha":"%s","branch":"%s","commit_time":"%s","published_at":"%s"}\n' \
  "$GIT_SHA" "$GIT_BRANCH" "$GIT_COMMIT_TIME" "$PUBLISHED_AT" \
  | ssh $SSHOPTS $REMOTE "cat > $APP/BUILD_INFO.json && cat $APP/BUILD_INFO.json"

echo "=== 4. 远端核对 ==="
ssh $SSHOPTS $REMOTE "du -sh $APP $APP/static; echo '--- app ---'; ls $APP; echo '--- static ---'; ls $APP/static | head"
echo "PUBLISH_OK"
