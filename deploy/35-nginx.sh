#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 3b：只更新 nginx vhost 并重载
#
#  与 30-system.sh 的第 2~4 步等价（同一份 vhost 源文件），
#  但**不动 systemd、不重启服务** —— 只改 nginx 时用它，
#  避免为了一次配置变更白踢一次后端进程。
#
#  前置：本机把 deploy/nginx-g.161303.xyz.conf 传到
#        /tmp/nginx-g.161303.xyz.conf
#  需要 sudo（脚本内部使用，命令行里不出现 sudo）
# ============================================================
set -euo pipefail

VHOST=/tmp/nginx-g.161303.xyz.conf
SITE=g.161303.xyz

[ -s "$VHOST" ] || { echo "!! 缺少 $VHOST"; exit 1; }

echo "=== 1. 安装 vhost ==="
sudo install -m 644 "$VHOST" "/etc/nginx/sites-available/$SITE"
sudo ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"

echo "=== 2. 语法校验 ==="
sudo nginx -t

echo "=== 3. 重载（reload，不中断连接）==="
sudo systemctl reload nginx
echo "NGINX_OK"
