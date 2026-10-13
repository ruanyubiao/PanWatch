#!/usr/bin/env bash
# ============================================================
#  PanWatch 源码部署 —— 步骤 2b：nginx basic auth 用户 ryb
#
#  前置：本地已用 `openssl passwd -apr1` 生成 `ryb:<hash>` 并传到
#        /tmp/ryb.line（明文密码全程不落到命令行输出与日志里）。
#
#  行为：
#    - 若 /etc/nginx/.htpasswd 已存在完全相同的 ryb 行 → 不动（幂等）
#    - 否则保留其它用户，替换/追加 ryb 行，并维持 640 root:www-data
#
#  只打印结论与用户名，绝不打印哈希。
# ============================================================
set -euo pipefail

HT=/etc/nginx/.htpasswd
NEW=/tmp/ryb.line

if [ ! -s "$NEW" ]; then
  echo "!! 缺少 $NEW（先在本机生成并上传）"
  exit 1
fi

if sudo grep -qF "$(cat "$NEW")" "$HT" 2>/dev/null; then
  echo "HTPASSWD_ALREADY_OK"
else
  sudo bash -c "grep -v '^ryb:' '$HT' > /tmp/ht.keep 2>/dev/null || true"
  sudo bash -c "cat /tmp/ht.keep '$NEW' > /tmp/ht.merged"
  sudo install -m 640 -o root -g www-data /tmp/ht.merged "$HT"
  sudo rm -f /tmp/ht.keep /tmp/ht.merged
  echo "HTPASSWD_UPDATED"
fi

sudo rm -f "$NEW"
echo -n "用户: "
sudo cut -d: -f1 "$HT" | tr '\n' ' '
echo
