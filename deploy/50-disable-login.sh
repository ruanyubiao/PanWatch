#!/usr/bin/env bash
# 关闭应用层登录（唯一入口留给 nginx basic auth）
# 做法：删掉 app_settings 里的 auth_username / auth_password_hash / jwt_secret
# 未设密码时 get_current_user 放行，前端也不再要求登录。
# 用法（服务器）：bash /opt/PanWatch/app/deploy/50-disable-login.sh
set -euo pipefail

V=/opt/PanWatch/venv/bin/python
DB=/opt/PanWatch/data/panwatch.db

$V - "$DB" <<'PYEOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
before = c.execute(
    "select key from app_settings where key in ('auth_username','auth_password_hash','jwt_secret')"
).fetchall()
print("删除前:", before)
c.execute("delete from app_settings where key in ('auth_username','auth_password_hash','jwt_secret')")
c.commit()
after = c.execute(
    "select key from app_settings where key in ('auth_username','auth_password_hash','jwt_secret')"
).fetchall()
print("删除后:", after)
print("settings 剩余:", c.execute("select count(*) from app_settings").fetchone()[0])
PYEOF

sudo systemctl restart panwatch
for i in $(seq 1 30); do
  sleep 2
  if curl -fsS http://127.0.0.1:8000/api/auth/status >/dev/null 2>&1; then
    echo "HEALTH_OK (${i} 次探测 × 2s)"
    break
  fi
  [ "$i" = "30" ] && { echo "!! 启动超时"; sudo journalctl -u panwatch -n 30 --no-pager; exit 1; }
done

echo "--- 重启后（验证是否自愈写回）---"
printf 'auth/status  : '; curl -s http://127.0.0.1:8000/api/auth/status; echo
printf 'market-table : '; curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8000/api/stocks/market-table?board=all&limit=1'
printf 'stocks       : '; curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8000/api/stocks?limit=1'
printf 'catalog      : '; curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8000/api/stocks/catalog?limit=1'
$V - "$DB" <<'PYEOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
rows = c.execute("select key from app_settings where key in ('auth_username','auth_password_hash')").fetchall()
print("库内 auth 行:", rows if rows else "无")
PYEOF
echo "LOGIN_DISABLED_OK"
