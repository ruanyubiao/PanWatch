"""数据分析（条件在历史上的准确率）。

模块划分：
    models.py   请求模型 + 常量（周期、前瞻天数）
    store.py    任务目录 / meta.json / signals.db
    forward.py  前瞻 30 个交易日、停牌顺延、对照组抽样
    runner.py   逐日跑条件选股的后台线程
    stats.py    胜率 / 超额 / 盈亏比 / 分组统计
    excel.py    明细.xlsx
    api         HTTP 入口（``src/modules/market/api/fork_analysis.py``）

设计底线：**条件判定不另写一套** —— 每天调 ``fork_screen.service.run_screen``，
所以报告里的「命中」与界面上选出来的股票是同一件事。
"""
