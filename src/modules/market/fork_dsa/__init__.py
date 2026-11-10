"""fork 专用：DSA 风格决策报告（「深度分析2」）。

来源与边界
----------
本包是 daily_stock_analysis（ZhuLinsen/daily_stock_analysis）分析口径的**移植**，
不是嵌入：报告的五段结构（``meta / summary / strategy / details``）与决策仪表盘
JSON 的字段名对齐那套实现，界面按它的报告页复刻，但**数据与模型全部用 PanWatch
自己的**：

- 行情 / K 线 / 均线 / 技术指标：本机 MySQL ``stock`` 库（``stock_daily``），
  零外网请求；
- 板块归属、资金流、个股新闻：东财公开接口（免费、无 key），失败即标注缺口；
- 模型：库里已配置的 AI service（``get_configured_failover_client``），不新拉 key。

模块划分：:

    data.py     取数（MySQL 快照 + 东财板块/资金流/新闻）
    prompt.py   DSA 的 SYSTEM_PROMPT 与用户提示词拼装
    schema.py   报告解析与归一化（LLM JSON → 五段结构）
    store.py    报告落 SQLite（``data/dsa_reports.db``）
    service.py  串起来：取数 → 调用模型 → 解析 → 落库
    api         HTTP 入口（``src/modules/market/api/fork_dsa.py``）

为什么不复用 DSA 的进程：它在内网容器里，云端 PanWatch 到内网没有路由；而且它
只有首页一个前端路由，报告靠状态渲染，没有按标的的深链。
"""
