#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 0：建目录（需 root，一次即可）
#  /opt/PanWatch 目前是 root 所有；这里把子目录建好并交给 ubuntu。
# ============================================================
set -euo pipefail
ROOT=/opt/PanWatch
install -d -m 755 -o ubuntu -g ubuntu "$ROOT" "$ROOT/app" "$ROOT/data" "$ROOT/logs" "$ROOT/deploy"
ls -la "$ROOT"
echo "DIRS_OK"
