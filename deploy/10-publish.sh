#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码发布（一条命令跑完整个发布）
#
#  用法：bash deploy/10-publish.sh
#
#  一次做完七步，任何一步失败会自动把推理单元和调度恢复回去：
#    0. 停推理：暂停调度 cron + 停掉在跑的 panwatch-infer-*（记下 done_iterations）
#    1. 清空远端 app/（保留 data）
#    2. 铺后端源码
#    3. 前端产物 → app/static
#    3.5 写 BUILD_INFO.json
#    4. 重启服务 + 健康自检（app/deploy/15-restart.sh）
#    5. 登录守卫自检（app/deploy/17-guard-auth.sh → 期望 AUTH_OK）
#    6. 上线核对（app/deploy/49-verify-deploy.sh：版本/迁移/接口/产物）
#    7. 恢复：续跑被停的推理单元 + 恢复调度 cron（deploy/16-infer-hold.sh release）
#
#  为什么第 0/7 步写进脚本（不再靠人手查）：
#    1. 第 1 步 `find app -mindepth 1 -delete` 会把正在跑的 worker 依赖的模块删掉，
#       worker 后续 import 失败只是「通常没立刻炸」的运气，不是保障。
#    2. 调度 cron 每 5 分钟 tick 一次，上一分钟查空、下一分钟就可能新起一轮
#       （实测 15:37 查空、15:40:08 就拉起一跑）。所以发布窗口内把 tick 行注释掉、
#       发完立刻恢复原样。
#
#  为什么用 tar 不用 rsync：本机（Hermes 容器）没有 rsync 可执行文件，
#  且容器内无 sudo 装不了；服务器端有 rsync 但推不过去。tar 走 ssh 管道效果等价。
#
#  同步内容：后端源码 + 前端源码 + frontend/dist → app/static
#  不同步：.git（服务器只运行不开发）、node_modules、.venv、
#          __pycache__、data（数据目录独立管理，避免被覆盖）
#
#  每次都是「清空 app/ 再铺」——保证服务器 == 本机构建产物，
#  不会残留上一次删掉的文件。
#
#  只改前端时不要跑这个脚本（会白重启、白打断推理），见
#  skills/panwatch-dev-env/references/frontend-ui-changes.md 的「只改前端时的部署」。
# ============================================================
set -euo pipefail

LOCAL=/opt/data/panwatch
REMOTE=ubuntu@110.42.222.4
KEY=/opt/data/home/.ssh/id_ed25519_stockcloud
APP=/opt/PanWatch/app
SSHOPTS="-i $KEY -o StrictHostKeyChecking=accept-new"
HOLD_SCRIPT="$LOCAL/deploy/16-infer-hold.sh"

EXCLUDES=(
  --exclude='./.git' --exclude='./.github' --exclude='./.venv'
  --exclude='./.pytest_cache' --exclude='./.agents'
  --exclude='./frontend/node_modules' --exclude='./frontend/dist'
  --exclude='./frontend/.vite' --exclude='./frontend/tsconfig.tsbuildinfo'
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.egg-info'
  --exclude='./data' --exclude='./.env'
  # 仓库根上曾出现过一个 static -> frontend/dist 的本地符号链接；tar 会把它原样搬到
  # 服务器，覆盖掉第 1 步建好的 app/static 目录，导致第 3 步无处解包。排除掉更稳。
  --exclude='./static'
)

# 远端跑辅助脚本：把本地文件喂给远端 bash，首次发布时远端还没有这个文件也能用。
remote_hold() {
  ssh $SSHOPTS $REMOTE "bash -s $1" < "$HOLD_SCRIPT"
}

# 任何一步失败：把推理单元与调度恢复回去，别留下「停着没人管」的推理轮。
on_fail() {
  rc=$?
  trap - ERR INT TERM
  echo "!! 发布中断（rc=$rc），尝试恢复推理单元与调度 cron" >&2
  remote_hold release || \
    echo "!! 恢复失败，手工重试：ssh $REMOTE 'bash -s release' < deploy/16-infer-hold.sh" >&2
  exit "$rc"
}
trap on_fail ERR INT TERM

echo "=== 0. 停推理：暂停调度 cron + 停单元 ==="
remote_hold hold

echo
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

echo
echo "=== 4. 重启服务 + 健康自检 ==="
ssh $SSHOPTS $REMOTE "bash $APP/deploy/15-restart.sh"

echo
echo "=== 5. 登录守卫自检（期望 AUTH_OK）==="
ssh $SSHOPTS $REMOTE "bash $APP/deploy/17-guard-auth.sh" | tail -5

echo
echo "=== 6. 上线核对 ==="
ssh $SSHOPTS $REMOTE "bash $APP/deploy/49-verify-deploy.sh" | sed -n '/=== 5. 接口/,$p'

echo
echo "=== 7. 恢复推理：续跑 + 恢复调度 cron ==="
trap - ERR INT TERM
remote_hold release

echo "PUBLISH_OK"
