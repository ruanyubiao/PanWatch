#!/usr/bin/env bash
# 升级前备份 panwatch.db（SQLite 在线备份 API，避免直接 cp 拷到写了一半的页）
# 用法（服务器上）：bash deploy/48-pre-upgrade-backup.sh
set -euo pipefail

DB=/opt/PanWatch/data/panwatch.db
TS=$(date +%Y%m%d-%H%M%S)
OUT=$DB.bak.$TS

/opt/PanWatch/venv/bin/python - "$DB" "$OUT" <<'PYEOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
print("backup written:", sys.argv[2])
PYEOF

/opt/PanWatch/venv/bin/python - "$OUT" <<'PYEOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print("integrity:", c.execute("PRAGMA integrity_check").fetchone()[0])
print("schema_version:", c.execute("select max(version) from schema_migrations").fetchone()[0])
print("stocks:", c.execute("select count(*) from stocks").fetchone()[0])
print("settings:", c.execute("select count(*) from app_settings").fetchone()[0])
PYEOF
ls -la "$OUT"
echo "BACKUP_OK $OUT"
