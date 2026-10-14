#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 4：数据目录与源码目录解耦
#
#  背景（踩过的坑）：
#    上游把 SQLite 路径硬编码为「源码目录/data/panwatch.db」
#    （src/platform/persistence/database.py 的 DB_PATH），
#    DATA_DIR 环境变量对它无效（那个变量只管 avatars / intraday state /
#    Docker 下的 playwright）。
#    于是 /opt/PanWatch/app/data 才是真正的数据目录，而 publish 原先是
#    `rm -rf app/*` —— 每次发布都把数据库删掉，服务随即报
#    sqlite3.OperationalError: unable to open database file。
#
#  解法：
#    /opt/PanWatch/app/data 做成指向 /opt/PanWatch/data 的符号链接，
#    真实文件（panwatch.db、stock_list_cache.json、avatars）都落在
#    /opt/PanWatch/data。publish 脚本已改为保留该链接。
#    DATA_DIR 仍设为 /opt/PanWatch/data，保证 avatars 等与库同处一地。
#
#  幂等：可重复执行。
# ============================================================
set -euo pipefail

ROOT=/opt/PanWatch

step() { echo; echo "=== $* ==="; }

step "1. 数据目录"
install -d -m 755 -o ubuntu -g ubuntu "$ROOT/data"

step "2. app/data → $ROOT/data"
if [ -L "$ROOT/app/data" ]; then
  echo "已是符号链接: $(readlink "$ROOT/app/data")"
elif [ -d "$ROOT/app/data" ]; then
  # 真实目录：先把服务停下来，避免迁移途中还有写入
  sudo systemctl stop panwatch 2>/dev/null || true
  sleep 2
  echo "迁移现有文件到 $ROOT/data ..."
  for f in "$ROOT/app/data"/* "$ROOT/app/data"/.[!.]*; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    if [ -e "$ROOT/data/$base" ]; then
      echo "  跳过（目标已存在）: $base"
    else
      mv "$f" "$ROOT/data/"
      echo "  迁移: $base"
    fi
  done
  rmdir "$ROOT/app/data"
  ln -s "$ROOT/data" "$ROOT/app/data"
  echo "已创建链接: $ROOT/app/data -> $ROOT/data"
else
  ln -s "$ROOT/data" "$ROOT/app/data"
  echo "已创建链接: $ROOT/app/data -> $ROOT/data"
fi
ls -ld "$ROOT/app/data"

step "3. 重启服务"
sudo systemctl restart panwatch
sleep 15
echo "服务状态: $(systemctl is-active panwatch)"

step "4. 数据目录内容"
ls -la "$ROOT/data/"

step "5. 数据库可写性（以 ubuntu 身份）"
sudo -u ubuntu "$ROOT/venv/bin/python" - <<'PYEOF'
import sqlite3, os
p = "/opt/PanWatch/app/data/panwatch.db"
print("解析路径:", os.path.realpath(p))
c = sqlite3.connect(p, timeout=5)
print("表数量:", c.execute("select count(*) from sqlite_master where type='table'").fetchone()[0])
c.close()
print("SQLITE_OK")
PYEOF

echo
echo "DATADIR_OK"
