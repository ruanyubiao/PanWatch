#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 2c：只更新 systemd 单元并重启
#
#  用法（在服务器上执行）：
#      bash /opt/PanWatch/deploy/16-apply-unit.sh
#  前置：本机把 deploy/panwatch.service 传到 /tmp/panwatch.service
#
#  为什么单独一个脚本：只改了单元文件（例如新增 EnvironmentFile=/opt/stock/.env）
#  时用 30-system.sh 会顺带跑 20-htpasswd.sh（需要 /tmp/ryb.line，会白改一次
#  basic auth 口令）。本脚本只做「装单元 + daemon-reload + 重启 + 自检」。
#
#  需要 sudo（脚本内部使用，命令行里不出现 sudo）
# ============================================================
set -euo pipefail

UNIT=/tmp/panwatch.service
[ -s "$UNIT" ] || { echo "!! 缺少 $UNIT（先在本机上传 deploy/panwatch.service）"; exit 1; }

echo "=== 1. 安装单元 ==="
sudo install -m 644 "$UNIT" /etc/systemd/system/panwatch.service
sudo systemctl daemon-reload

echo "=== 2. 重启 ==="
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
echo "=== 3. 注入的行情库变量（只列键名，不打印值）==="
sudo systemctl show panwatch -p Environment --value | tr ' ' '\n' | cut -d= -f1 | grep -c '^STOCK_DB' \
  | sed 's/^/STOCK_DB_* 变量个数: /'
echo "UNIT_OK"
