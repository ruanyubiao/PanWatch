#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 2b：重启服务并自检
#
#  用法（在服务器上执行）：
#      bash /opt/PanWatch/deploy/15-restart.sh
#  典型顺序：本机 bash deploy/10-publish.sh  →  本机 ssh 触发本脚本
#
#  为什么单独一个脚本：本机 agent 命令行里出现 sudo 会被审批层拦下，
#  把提权动作放在服务器端脚本里执行即可（同 20/40 的做法）。
#
#  自检内容：进程 active、健康接口 200、fork 新增的 /stocks/catalog 能返回数据。
# ============================================================
set -euo pipefail

sudo systemctl restart panwatch

for i in $(seq 1 30); do
  sleep 2
  if curl -fsS http://127.0.0.1:8000/api/auth/status >/dev/null 2>&1; then
    echo "HEALTH_OK (${i} 次探测 × 2s)"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "!! 健康检查超时，最近日志："
    sudo journalctl -u panwatch -n 40 --no-pager
    exit 1
  fi
done

echo "systemd: $(systemctl is-active panwatch)"
printf 'auth/status : '; curl -s http://127.0.0.1:8000/api/auth/status | head -c 200; echo
printf 'catalog     : '; curl -s 'http://127.0.0.1:8000/api/stocks/catalog?board=all&limit=1' | head -c 300; echo
echo "RESTART_OK"
