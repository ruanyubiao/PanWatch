#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 4：导入 gp1(docker 版) 的数据
#
#  用法（在服务器上执行）：
#      bash /opt/PanWatch/deploy/45-import-db.sh [源库路径]
#  默认源：/opt/appconfig/panwatch/data/panwatch.db
#
#  目的（用户要求）：
#    1. 复用 gp1 里的 AI 配置（ai_services / ai_models / agent_configs）与关注列表；
#    2. 应用自带的登录**保留**（用户要求：不做「登录放行」）—— 账号口令沿用 gp1 的，
#       因此这里**不再**删除 auth_username / auth_password_hash / jwt_secret。
#       两层认证的配合方式见 deploy/nginx-g.161303.xyz.conf（/api/ 与 /mcp 必须
#       auth_basic off，否则前端的 Bearer 会和 basic 抢同一个 Authorization 头）。
#
#  注意：必须在 panwatch 服务停止时替换，避免写入半途被覆盖；
#        替换后由应用启动时的迁移把旧库补到当前 schema（gp1 落后 2 个迁移，安全）。
# ============================================================
set -euo pipefail

SRC="${1:-/opt/appconfig/panwatch/data/panwatch.db}"
DST=/opt/PanWatch/data/panwatch.db
PY=/opt/PanWatch/venv/bin/python

[ -f "$SRC" ] || { echo "!! 源库不存在: $SRC"; exit 1; }

echo "=== 1. 停服务 ==="
sudo -n systemctl stop panwatch
# 替换前把现有库留一份带时间戳的备份（回滚用）
if [ -f "$DST" ]; then
  cp -a "$DST" "$DST.bak.$(date +%Y%m%d-%H%M%S)"
fi

echo "=== 2. 拷入源库 ==="
cp -a "$SRC" "$DST"
rm -f "$DST-wal" "$DST-shm"   # 主库换了，旧 WAL 必须清掉

echo "=== 3. 保留应用层账号密码（不打印任何值，只打印键名）==="
"$PY" - <<'PYEOF'
import sqlite3

db = '/opt/PanWatch/data/panwatch.db'
conn = sqlite3.connect(db)
# fork：应用自带登录是要用的（用户要求），所以这里**不删**
# auth_username / auth_password_hash / jwt_secret —— 旧版本会删掉这三项让登录放行，
# 现在删了就会掉进「初始化」流程。只做核对，不做写入。
print('app_settings 键:', [r[0] for r in conn.execute('select key from app_settings order by key')])
print('auth 状态    :', [r[0] for r in conn.execute("select key from app_settings where key like 'auth%' or key = 'jwt_secret'")] or '未设置（登录页会走初始化流程）')
print('stocks 总数  :', conn.execute('select count(*) from stocks').fetchone()[0],
      '| CN:', conn.execute("select count(*) from stocks where market='CN'").fetchone()[0])
print('ai_services  :', conn.execute('select count(*) from ai_services').fetchone()[0])
print('agent_configs:', conn.execute('select count(*) from agent_configs').fetchone()[0])
PYEOF

echo "=== 4. 起服务（启动时会跑迁移）==="
sudo -n systemctl start panwatch

for i in $(seq 1 30); do
  sleep 2
  if curl -fsS http://127.0.0.1:8000/api/auth/status >/dev/null 2>&1; then
    echo "HEALTH_OK (${i} 次探测 × 2s)"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "!! 健康检查超时，最近日志："
    sudo -n journalctl -u panwatch -n 60 --no-pager
    exit 1
  fi
done

printf 'auth/status : '; curl -s http://127.0.0.1:8000/api/auth/status; echo
printf 'stocks      : '; curl -s http://127.0.0.1:8000/api/stocks | head -c 400; echo
echo "IMPORT_OK"
