#!/usr/bin/env bash
# 云端上线核对：认证明细 + 「用户实际下载到的产物里有没有这次的改动」。
#
# **在本机（开发机）跑，不是在服务器上跑** —— 用本机 curl 打公网域名，
# 拿本地 dist 的 sha256 与线上真正被下载的那份比。（服务器上跑的那份是
# verify_market_table.py，管应用内接口对数。）
#
#   bash deploy/fork-verify-fork-assets.sh
#
# 口令从 notes 文件读进 shell 变量，不 print、不落盘（照 panwatch-dev-env 的规矩）。
# chunk 名每次构建都会变，所以先按 index.html 里引用的名字找，找不到就顺 entry chunk 里
# 的 import 路径再找一层 —— 不要把这个脚本写死成某一次的 hash，否则下轮必然失效。
set -uo pipefail

PASS=$(sed -n '2p' /opt/data/notes/nginx-auth.md | tr -d '\r\n')
BASE=https://g.161303.xyz
LOCAL_DIST=/opt/data/panwatch/frontend/dist

echo "=== 1. nginx 认证矩阵（两层认证的期望值）==="
printf '  根路径 无凭据        : '; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"
printf '  根路径 错口令        : '; curl -s -o /dev/null -w '%{http_code}\n' -u ryb:definitely-wrong "$BASE/"
printf '  根路径 带凭据        : '; curl -s -o /dev/null -w '%{http_code}\n' -u "ryb:$PASS" "$BASE/"
printf '  manifest 无凭据      : '; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/manifest.json"
printf '  sw.js 无凭据         : '; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/sw.js"
printf '  /api/ 无凭据         : '; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/auth/status"

echo "=== 2. 定位线上分析页那个 chunk ==="
HTML=$(curl -s -u "ryb:$PASS" "$BASE/")
CHUNK=$(printf '%s' "$HTML" | grep -o 'assets/ForkAnalysis-[A-Za-z0-9_-]*\.js' | head -1)
if [ -z "$CHUNK" ]; then
  ENTRY=$(printf '%s' "$HTML" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
  printf '  index.html 里没有，顺 entry chunk 找：%s\n' "$ENTRY"
  CHUNK=$(curl -s -u "ryb:$PASS" "$BASE/$ENTRY" | grep -o 'assets/ForkAnalysis-[A-Za-z0-9_-]*\.js' | head -1)
fi
printf '  chunk                : %s\n' "${CHUNK:-（没找到）}"
[ -z "$CHUNK" ] && { echo "!! 找不到分析页 chunk"; exit 1; }

curl -s -u "ryb:$PASS" "$BASE/$CHUNK" -o /tmp/served-fork-chunk.js
NAME=$(basename "$CHUNK")
printf '  下载字节数           : %s\n' "$(wc -c < /tmp/served-fork-chunk.js)"
printf '  本地 dist 同名文件   : %s 字节\n' "$(wc -c < "$LOCAL_DIST/assets/$NAME" 2>/dev/null || echo 0)"
printf '  sha256 线上 == 本地  : '
L=$(sha256sum "$LOCAL_DIST/assets/$NAME" 2>/dev/null | cut -d' ' -f1)
S=$(sha256sum /tmp/served-fork-chunk.js | cut -d' ' -f1)
if [ -n "$L" ] && [ "$L" = "$S" ]; then echo "一致 ${S:0:16}…"; else echo "不一致 local=${L:0:16}… served=${S:0:16}…"; fi

echo "=== 3. 这轮改动的特征字符串（按需增删）==="
for pat in '全部市场' 'w-\[208px\]' 'w-\[104px\]'; do
  printf '  %-14s : %s 次\n' "$pat" "$(grep -o "$pat" /tmp/served-fork-chunk.js | wc -l)"
done
echo "VERIFY_ASSETS_DONE"
