#!/usr/bin/env bash
# ============================================================
#  发布后守卫：确认应用登录配置还在（auth_username / auth_password_hash / jwt_secret）
#
#  背景（2026-11-05）：一次完整发布 + 重启之后，app_settings 里这三行消失，
#  表现是 /api/auth/login 返回 400 auth_not_configured、调度器 tick 变成
#  api_unreachable、网页登录进不去。原因查到的边界是「发布后 app_settings 被
#  默认值重建」，所以把它变成发布后的固定自检项：缺了就从最近的 .bak 里补回来。
#
#  用法（服务器）：bash /opt/PanWatch/deploy/17-guard-auth.sh [--check]
#    --check  只看，不改
# ============================================================
set -euo pipefail

V=/opt/PanWatch/venv/bin/python
DATA=/opt/PanWatch/data
DB=$DATA/panwatch.db
MODE=${1:-apply}

$V - "$DB" "$DATA" "$MODE" <<'PYEOF'
import glob
import os
import sqlite3
import sys

db_path, data_dir, mode = sys.argv[1], sys.argv[2], sys.argv[3]
keys = ("auth_username", "auth_password_hash", "jwt_secret")

live = sqlite3.connect(db_path)
present = {row[0] for row in live.execute(
    "select key from app_settings where key in (?,?,?)", keys)}
missing = [key for key in keys if key not in present]
print("auth rows now:", sorted(present) or "（空）")
if not missing:
    print("AUTH_OK")
    raise SystemExit(0)
print("MISSING:", missing)

if mode == "--check":
    raise SystemExit(2)

# 从最新的还没被破坏的 .bak 里补
backups = sorted(glob.glob(os.path.join(data_dir, "panwatch.db.bak*")),
                 key=os.path.getmtime, reverse=True)
for path in backups:
    try:
        src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = src.execute(
            "select key, value, description from app_settings where key in (?,?,?)",
            keys).fetchall()
        src.close()
    except sqlite3.DatabaseError:
        continue
    if not rows:
        continue
    for key, value, desc in rows:
        cur = live.execute("update app_settings set value=? where key=?", (value, key))
        if cur.rowcount == 0:
            live.execute("insert into app_settings(key,value,description) values(?,?,?)",
                         (key, value, desc))
    live.commit()
    print(f"RESTORED from {os.path.basename(path)}: {[row[0] for row in rows]}")
    print("（重启 panwatch 让 token 生效）")
    raise SystemExit(0)

print("!! 没有任何备份含 auth 配置：需要重新设置账号（/api/auth/setup）")
raise SystemExit(1)
PYEOF
