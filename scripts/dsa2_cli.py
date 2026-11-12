#!/usr/bin/env python3
"""深度分析2（fork_dsa）的命令行工具：查队列、看报告、同步跑一只票。

为什么需要它
------------
网页入口要经过 nginx basic auth + 应用登录，排障时拿 token 很麻烦；这个脚本
直接读 ``/opt/PanWatch/data/dsa_reports.db``，用同一份业务代码，不走 HTTP。

子命令
------
* ``ls``                 —— 最近 15 条报告（id / 代码 / 名称 / 状态 / 时间 / 错误）
* ``queue``              —— 当前队列（第一个是运行中，其余等待）
* ``show SYMBOL [PATH]`` —— 取最新一份报告的某个字段，PATH 用点号取子节点
* ``raw SYMBOL``         —— 最新一份报告的整段 payload
* ``enqueue SYMBOL [NAME]`` —— 入队（由常驻消费者线程认领，正常路径）
* ``run SYMBOL [NAME]``  —— 同步跑一只（不进队列，占住终端；只用于排障）
* ``check``              —— 自检：只读行情库能不能连、最新交易日是哪天

为什么自己要读 /opt/stock/.env
------------------------------
服务运行时由 systemd 的 ``EnvironmentFile=/opt/stock/.env`` 注入 STOCK_DB_RO_*；
手工在 shell 里跑没有这层注入，之前因此产生过一份「未配置只读行情库」的失败报告。
这里显式加载同一份文件（已存在的同名变量不覆盖），让手工跑与服务跑行为一致。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

APP_DIR = "/opt/PanWatch/app"
DB = "/opt/PanWatch/data/dsa_reports.db"
ENV_FILE = "/opt/stock/.env"


def load_env(path: str = ENV_FILE) -> None:
    """把 /opt/stock/.env 读进 os.environ（不覆盖已有值，容忍引号与注释）。"""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, _, val = s.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def _store():
    sys.path.insert(0, APP_DIR)
    from src.modules.market.fork_dsa import store  # noqa: PLC0415

    return store


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=20)
    c.row_factory = sqlite3.Row
    return c


def cmd_ls(_args: argparse.Namespace) -> int:
    with _conn() as c:
        rows = c.execute(
            "select id,symbol,name,status,created_at,started_at,"
            "substr(coalesce(error,''),1,80) e from dsa_reports order by id desc limit 15"
        ).fetchall()
    if not rows:
        print("(空)")
        return 0
    for r in rows:
        print(
            f"{r['id']:>4}  {r['symbol']:<10} {(r['name'] or '-'):<8} {r['status']:<8} "
            f"start={r['started_at'] or '-'}  {r['e'] or ''}"
        )
    return 0


def cmd_queue(_args: argparse.Namespace) -> int:
    store = _store()
    rows = store.queue_rows()
    if not rows:
        print("(队列空)")
        return 0
    for i, r in enumerate(rows):
        tag = "运行" if i == 0 else f"等待(前{i}个)"
        print(f"{r['id']:>4}  {r['symbol']:<10} {(r.get('name') or '-'):<8} {tag}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    store = _store()
    row = store.latest(args.symbol)
    if not row:
        print(f"没有 {args.symbol} 的报告")
        return 1
    payload = row.get("report") or {}
    if not payload:
        print(f"{args.symbol} id={row['id']} status={row['status']} 没有 payload（{row.get('error') or ''}）")
        return 1
    node = payload
    for part in [p for p in (args.path or "").split(".") if p]:
        if not isinstance(node, dict) or part not in node:
            print(f"路径不存在：{args.path}")
            print("顶层键：" + ", ".join(payload.keys()))
            return 1
        node = node[part]
    print(json.dumps(node, ensure_ascii=False, indent=1)[:6000])
    return 0


def cmd_raw(args: argparse.Namespace) -> int:
    return cmd_show(argparse.Namespace(symbol=args.symbol, path=""))


def cmd_enqueue(args: argparse.Namespace) -> int:
    store = _store()
    rid = store.create(args.symbol, args.name)
    print(f"enqueued {args.symbol} {args.name or ''} id={rid}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    store = _store()
    from src.modules.market.fork_dsa import service  # noqa: PLC0415

    row = store.latest(args.symbol)
    if row and row.get("status") == "queued":
        store.cancel(row["id"])
        print(f"dropped stale queued row {row['id']}", flush=True)
    out = service.run_sync(args.symbol, args.name)
    print("RESULT", out.get("id"), out.get("status"), flush=True)
    if out.get("error"):
        print("ERROR", out["error"], flush=True)
        return 1
    payload = out.get("payload") or {}
    print("MODEL", (payload.get("meta") or {}).get("model_used"), flush=True)
    return 0


def cmd_check(_args: argparse.Namespace) -> int:
    sys.path.insert(0, APP_DIR)
    from src.modules.market.fork_dsa import calendar, data  # noqa: PLC0415

    print("STOCK_DB_RO_USER =", "已设置" if os.getenv("STOCK_DB_RO_USER") else "缺失")
    try:
        conn = data._connect()  # noqa: SLF001
    except Exception as exc:  # noqa: BLE001
        print("行情库不可用：", exc)
        return 1
    try:
        with conn.cursor() as cur:
            cur.execute("select max(trade_date) as d from stock_daily")
            row = cur.fetchone() or {}
            print("最新交易日 =", row.get("d") if isinstance(row, dict) else row)
    finally:
        conn.close()
    print("交易日状态 =", json.dumps(calendar.resolve(), ensure_ascii=False, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    load_env()
    p = argparse.ArgumentParser(description="深度分析2 命令行工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ls", help="最近 15 条报告").set_defaults(func=cmd_ls)
    sub.add_parser("queue", help="当前队列").set_defaults(func=cmd_queue)
    sub.add_parser("check", help="行情库自检").set_defaults(func=cmd_check)

    sp = sub.add_parser("show", help="看最新报告的一个字段")
    sp.add_argument("symbol")
    sp.add_argument("path", nargs="?", default="")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("raw", help="看最新报告的整段 payload")
    sp.add_argument("symbol")
    sp.set_defaults(func=cmd_raw)

    for name, func in (("enqueue", cmd_enqueue), ("run", cmd_run)):
        sp = sub.add_parser(name, help=f"{name} 一只票")
        sp.add_argument("symbol")
        sp.add_argument("name", nargs="?", default=None)
        sp.set_defaults(func=func)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
