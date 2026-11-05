#!/usr/bin/env bash
# 上线后核对：版本、依赖、迁移、数据完整性、接口
# 用法（服务器）：bash /opt/PanWatch/app/deploy/49-verify-deploy.sh
set -uo pipefail

V=/opt/PanWatch/venv/bin/python
B=http://127.0.0.1:8000

echo "=== 1. systemd ==="
systemctl is-active panwatch
systemctl show panwatch -p ActiveEnterTimestamp --value

echo
echo "=== 2. 版本 / 构建信息 ==="
cat /opt/PanWatch/app/BUILD_INFO.json

echo
echo "=== 3. 依赖版本 ==="
$V - <<'PYEOF'
from importlib.metadata import version
for p in ("tradingagents", "pan-investment-research", "langchain-core", "langgraph", "pymysql", "openpyxl", "fastapi"):
    try:
        print(f"  {p:26s} {version(p)}")
    except Exception as e:
        print(f"  {p:26s} MISSING ({type(e).__name__})")
import pan_investment_research
print("  pan_investment_research import: OK")
PYEOF

echo
echo "=== 4. 数据库迁移与数据 ==="
$V - <<'PYEOF'
import sqlite3
c = sqlite3.connect("/opt/PanWatch/data/panwatch.db")
print("  schema_version:", c.execute("select max(version) from schema_migrations").fetchone()[0])
print("  failed_migrations:", c.execute("select version,name from schema_migrations where success<>1").fetchall())
print("  stocks:", c.execute("select count(*) from stocks").fetchone()[0])
print("  settings:", c.execute("select count(*) from app_settings").fetchone()[0])
print("  auth rows:", c.execute("select key from app_settings where key in ('auth_username','auth_password_hash')").fetchall())
print("  ai keys:", c.execute("select count(*) from app_settings where key like '%api_key%' or key like '%model%'").fetchone()[0])
PYEOF

echo
echo "=== 5. 接口 ==="
for p in /api/health /api/auth/status "/api/stocks?limit=1" "/api/stocks/catalog?limit=1" /openapi.json; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$B$p")
  echo "  $code  $p"
done
printf '  auth/status body: '; curl -s $B/api/auth/status | head -c 200; echo

echo
echo "=== 6. 前端产物 ==="
grep -o 'index-[A-Za-z0-9_-]*\.js' /opt/PanWatch/app/static/index.html
grep -o 'ForkAnalysis-[A-Za-z0-9_-]*\.js' /opt/PanWatch/app/static/index.html | head -1
ls -la /opt/PanWatch/app/static/index.html
echo "=== 6b. manifest 公开可取（应 200）==="
for p in /manifest.json /manifest.zh-CN.json; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$p")
  echo "  $code  $p"
done

echo
echo "=== 7. 错误日志（本次启动后）==="
journalctl -u panwatch --since "-10 min" -p err --no-pager | tail -20
echo "VERIFY_DONE"
