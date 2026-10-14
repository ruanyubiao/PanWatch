#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 1：目录 + 系统依赖 + Python 环境
#
#  目标机：110.42.222.4（腾讯云 Ubuntu 26.04）
#  目标根目录：/opt/PanWatch
#    app/    源码（含 static/ = 前端构建产物）
#    data/   DATA_DIR（panwatch.db / state / tradingagents 缓存）
#    venv/   Python 虚拟环境（uv 装的独立 CPython 3.13）
#    logs/   日志
#    deploy/ 本目录（部署脚本）
#
#  为什么用 uv 装 3.13：宿主机只有 python3.14，而上游依赖
#  （tradingagents / langchain 等）在 3.14 上轮子覆盖不足。
#  uv 能直接拉独立 CPython，不污染系统 python。
#
#  可重复执行（幂等）：已存在的目录/venv/包不重复装。
# ============================================================
set -euo pipefail

ROOT=/opt/PanWatch
APP=$ROOT/app
PY=3.13

step() { echo; echo "=== $* ==="; }

step "1. 目录"
sudo install -d -m 755 -o ubuntu -g ubuntu "$ROOT" "$ROOT/logs" "$ROOT/deploy" "$ROOT/data" "$APP"
ls -la "$ROOT"

step "2. 系统依赖（weasyprint 需要 pango/cairo，中文字体，playwright 需要的库）"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
  libffi-dev shared-mime-info fonts-noto-cjk \
  build-essential python3-dev git curl ca-certificates unzip
echo "系统依赖 OK"

step "3. uv"
if ! command -v "$HOME/.local/bin/uv" >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
uv --version

step "4. Python $PY + venv"
uv python install "$PY"
if [ ! -x "$ROOT/venv/bin/python" ]; then
  uv venv --python "$PY" "$ROOT/venv"
fi
"$ROOT/venv/bin/python" -V

step "5. Python 依赖（requirements.txt 全量，含 tradingagents 深度分析）"
cd "$APP"
if [ -f requirements.txt ]; then
  uv pip install --python "$ROOT/venv/bin/python" -r requirements.txt
else
  echo "!! $APP/requirements.txt 不存在，跳过（先同步源码）"
  exit 2
fi

step "6. Playwright 浏览器（chromium）"
"$ROOT/venv/bin/python" -m playwright install --with-deps chromium || \
  echo "!! playwright chromium 安装失败（非致命，后续按需重试）"

step "7. 验收"
"$ROOT/venv/bin/python" - <<'PYEOF'
import importlib, sys
mods = ["fastapi","uvicorn","sqlalchemy","apscheduler","akshare","efinance",
        "playwright","jwt","pandas","httpx"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(f"{m}: {e}")
print("python", sys.version.split()[0])
print("缺失/失败:", bad if bad else "无")
PYEOF

echo
echo "BOOTSTRAP_OK"
