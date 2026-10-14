#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 3：systemd 单元 + nginx vhost + basic auth
#
#  需要 sudo。前置文件（本机上传到 /tmp）：
#    /tmp/panwatch.service            systemd 单元
#    /tmp/nginx-g.161303.xyz.conf     nginx 站点配置
#    /tmp/ryb.line                    nginx basic auth 的 `ryb:<apr1 hash>` 行
#                                     （由本机 openssl 生成，明文口令不出现）
#
#  幂等：可重复执行；已存在的配置会被覆盖成最新版本。
# ============================================================
set -euo pipefail

UNIT=/tmp/panwatch.service
VHOST=/tmp/nginx-g.161303.xyz.conf
SITE=g.161303.xyz

step() { echo; echo "=== $* ==="; }

step "1. systemd 单元"
[ -s "$UNIT" ] || { echo "!! 缺少 $UNIT"; exit 1; }
sudo install -m 644 "$UNIT" /etc/systemd/system/panwatch.service
sudo systemctl daemon-reload
sudo systemctl enable panwatch >/dev/null 2>&1 || true
sudo systemctl restart panwatch
sleep 10
echo "systemd 状态: $(systemctl is-active panwatch)"

step "2. nginx 站点配置"
[ -s "$VHOST" ] || { echo "!! 缺少 $VHOST"; exit 1; }
sudo install -m 644 "$VHOST" "/etc/nginx/sites-available/$SITE"
sudo ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"

step "3. nginx basic auth（用户 ryb）"
bash /opt/PanWatch/deploy/20-htpasswd.sh

step "4. 校验并重载 nginx"
sudo nginx -t
sudo systemctl reload nginx
echo "NGINX_RELOADED"

step "5. 结论"
echo "systemd: $(systemctl is-active panwatch)"
echo "监听: $(sudo ss -ltnp 2>/dev/null | grep -E ':8000' | head -2)"
echo "站点: $(ls /etc/nginx/sites-enabled/)"
echo "SYSTEM_OK"
