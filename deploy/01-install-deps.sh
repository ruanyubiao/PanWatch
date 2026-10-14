#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 1b：Python 依赖安装
#
#  与 00-bootstrap.sh 第 5 步的区别：tradingagents 用本地 vendor
#  副本安装，不走 git+https。
#
#  原因：服务器（腾讯云上海）出口到 github.com 不稳定，
#  uv 解析 git 依赖时 TLS 连接被中断（GnuTLS recv error -110），
#  导致整个 requirements 安装失败、venv 空置。
#  解决办法：在能访问 GitHub 的机器上 clone 好，tar 到
#  /opt/PanWatch/vendor/tradingagents，本地安装。
#
#  可重复执行（幂等）。
# ============================================================
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
ROOT=/opt/PanWatch
V=$ROOT/venv/bin/python
APP=$ROOT/app
VENDOR=$ROOT/vendor/tradingagents

step() { echo; echo "=== $* ==="; }

cd "$APP"

step "A. 本地 vendor 版 tradingagents（含其 langchain/langgraph 等依赖）"
uv pip install --python "$V" "$VENDOR"

step "B. 其余依赖（过滤掉 tradingagents 的 git 行）"
# 注意：tradingagents 那行写在 requirements-runtime.txt 里（requirements.txt 只
# 有一行 `-r requirements-runtime.txt`），只过滤 requirements.txt 是无效的。
# 两个文件都要过滤，并让 -r 指向过滤后的 runtime 文件。
# 文件必须生成在 app/ 目录内：里面有 `-e ./packages/...` 这类相对路径，
# uv 按「包含文件所在目录」解析，放 /tmp 会找不到。
cd "$APP"
grep -v '^tradingagents' requirements-runtime.txt > .req-fork-runtime.txt
sed 's|^-r requirements-runtime.txt|-r .req-fork-runtime.txt|' requirements.txt \
  | grep -v '^tradingagents' > .req-fork-nota.txt
uv pip install --python "$V" -r .req-fork-nota.txt
rm -f .req-fork-nota.txt .req-fork-runtime.txt

step "B2. fork 额外依赖：MySQL 只读驱动（分析页读本机 stock 库要用）"
# 不要写进上游 requirements.txt（上游文件，制造 merge 冲突），fork 自己的步骤装。
uv pip install --python "$V" pymysql

step "C. Playwright chromium"
"$V" -m playwright install --with-deps chromium || echo "!! chromium 失败（非致命）"

step "D. 验收"
"$V" - <<'PYEOF'
import importlib, sys
mods = ["fastapi","uvicorn","sqlalchemy","apscheduler","akshare","efinance",
        "playwright","jwt","pandas","httpx","tradingagents","langchain","langgraph",
        "yfinance","openai","apscheduler","pymysql"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(f"{m}: {type(e).__name__}: {e}")
print("python", sys.version.split()[0])
print("缺失/失败:", bad if bad else "无")
PYEOF

echo
echo "DEPS_OK"
