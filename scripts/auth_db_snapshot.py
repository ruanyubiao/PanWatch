#!/usr/bin/env python3
"""给发布后守卫留一份极小的 app_settings 快照。

背景：deploy/17-guard-auth.sh 在 auth_username / auth_password_hash / jwt_secret
三行丢失时，会从 data 目录里最新的 panwatch.db.bak* 里回补。历史上这些 .bak 是
整库拷贝（每个近 400~470M），为了一个 12K 的快照养着 1.2G 的旧库并不划算。
2026-11-19 清理时改成只留一张表：文件名同样以 panwatch.db.bak 开头，守卫脚本
的 glob 照样能匹配到，实测回补路径可用。

用法（服务器）：
    /opt/PanWatch/venv/bin/python /opt/PanWatch/scripts/auth_db_snapshot.py
    ... --prune 3      # 只保留最近 3 份快照，其余删掉（默认不删）
    ... --dry-run      # 只看会做什么

注意：这**不是**数据库备份。真备份走 COS 周备份。这个文件只兜「发布后 app_settings
被默认值重建」这一个已知故障，别拿它当回滚点。
"""
from __future__ import annotations

import argparse
import glob
import os
import sqlite3
import sys
import time

PREFIX = "panwatch.db.bak-authsnap-"
AUTH_KEYS = ("auth_username", "auth_password_hash", "jwt_secret")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/opt/PanWatch/data")
    ap.add_argument("--prune", type=int, default=0,
                    help="保留最近 N 份快照，0=不删")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    live = os.path.join(args.data_dir, "panwatch.db")
    if not os.path.exists(live):
        sys.exit(f"refuse: {live} 不存在")

    src = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
    rows = src.execute(
        "select key, value, description from app_settings").fetchall()
    src.close()

    keys = {r[0] for r in rows}
    missing = [k for k in AUTH_KEYS if k not in keys]
    if missing:
        # 库本身就不完整时不要留快照，否则等于把坏状态固化下来
        sys.exit(f"refuse: 活库里缺 {missing}，先跑 17-guard-auth.sh apply")

    snap = os.path.join(args.data_dir, PREFIX + time.strftime("%Y%m%d-%H%M%S"))
    if args.dry_run:
        print(f"[dry-run] would write {snap} ({len(rows)} rows)")
    elif os.path.exists(snap):
        # 同一秒内重复执行会撞名；内容等价（都取自当前活库），直接复用
        print(f"exists, reuse {snap}")
    else:
        dst = sqlite3.connect(snap)
        dst.execute("create table app_settings "
                    "(key text primary key, value text, description text)")
        dst.executemany(
            "insert or replace into app_settings(key,value,description) values(?,?,?)",
            rows)
        dst.commit()
        dst.close()
        os.chmod(snap, 0o600)

        chk = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
        got = {r[0] for r in chk.execute("select key from app_settings")}
        chk.close()
        if not set(AUTH_KEYS) <= got:
            sys.exit(f"verify failed: {snap} 缺 {sorted(set(AUTH_KEYS) - got)}")
        print(f"wrote {snap} ({len(rows)} rows, {os.path.getsize(snap)} bytes)")

    if args.prune > 0:
        olds = sorted(glob.glob(os.path.join(args.data_dir, PREFIX + "*")),
                      key=os.path.getmtime, reverse=True)[args.prune:]
        for p in olds:
            print(("[dry-run] would remove " if args.dry_run else "removed ") + p)
            if not args.dry_run:
                os.remove(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
