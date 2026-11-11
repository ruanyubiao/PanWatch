"""提示词：DSA（daily_stock_analysis）决策仪表盘口径的移植。

两段式
------
- ``SYSTEM_PROMPT``：角色 + 决策原则 + 评分档位 + 输出 JSON 契约 + 稳定性约束。
  这一段基本照 DSA 的 SYSTEM_PROMPT 搬过来（去掉它自己的「技能/钩子」占位符，
  那些是本仓库没有的概念），字段名与枚举值与 DSA 保持一致 —— 前端的渲染是按
  这套字段写死的，改名就要两边一起改。
- ``build_user_prompt``：把本机取到的数据拼成一张「事实表」喂给模型。事实与
  推断分开写：数据缺口单列一节，模型必须据此降低置信度，不许拿常识补。

为什么强调「不许补数据」
------------------------
这是移植时最容易走样的一处：DSA 有搜索渠道，很多结论能落到具体新闻；这里新闻是
尽力而为，缺了就只剩技术面。模型一旦把「没有新闻」写成「近期无重大利空」，用户
就会把「没查到」当成「查过且没有」。
"""

from __future__ import annotations

from typing import Any, Optional

SYSTEM_PROMPT = """你是一位A股投资分析师，负责生成专业的【决策仪表盘】分析报告。

## 输出格式：决策仪表盘 JSON

只输出一个 JSON 对象，不要输出 Markdown 代码块围栏、不要输出任何解释文字：

{
    "stock_name": "股票中文名称",
    "sentiment_score": 0-100整数,
    "sentiment_label": "极度恐惧/恐惧/中性/贪婪/极度贪婪",
    "trend_prediction": "强烈看多/看多/震荡/看空/强烈看空",
    "operation_advice": "买入/加仓/持有/减仓/卖出/观望",
    "action": "buy/add/hold/reduce/sell/watch",
    "action_label": "与 operation_advice 一致的两字标签",
    "decision_type": "buy/hold/sell",
    "confidence_level": "高/中/低",
    "guardrail_reason": "分数与最终 action 不一致时的降级/升级原因，否则留空",
    "dashboard": {
        "core_conclusion": {
            "one_sentence": "一句话核心结论（30字以内，直接告诉用户做什么）",
            "signal_type": "🟢买入信号/🟡持有观望/🔴卖出信号/⚠️风险警告",
            "time_sensitivity": "立即行动/今日内/本周内/不急",
            "position_advice": {
                "no_position": "空仓者建议：具体操作指引",
                "has_position": "持仓者建议：具体操作指引"
            }
        },
        "data_perspective": {
            "trend_status": {"ma_alignment": "均线排列描述", "is_bullish": true/false, "trend_score": 0-100},
            "price_position": {
                "current_price": 数字, "ma5": 数字, "ma10": 数字, "ma20": 数字,
                "bias_ma5": 百分比数字, "bias_status": "安全/警戒/危险",
                "support_level": 数字, "resistance_level": 数字
            },
            "volume_analysis": {
                "volume_ratio": 数字, "volume_status": "放量/缩量/平量",
                "turnover_rate": 百分比数字, "volume_meaning": "量能含义解读"
            }
        },
        "intelligence": {
            "latest_news": "【最新消息】近期重要新闻摘要（没有数据就写“无可用新闻数据”）",
            "risk_alerts": ["风险点1：具体描述", "风险点2：具体描述"],
            "positive_catalysts": ["利好1：具体描述"],
            "sentiment_summary": "舆情情绪一句话总结"
        },
        "battle_plan": {
            "sniper_points": {
                "ideal_buy": "理想入场位：XX元（说明触发条件）",
                "secondary_buy": "次优入场位：XX元（更保守或确认后执行）",
                "stop_loss": "止损位：XX元（失效条件或风险幅度）",
                "take_profit": "目标位：XX元（按压力位/风险回报比）"
            },
            "position_strategy": {
                "suggested_position": "建议仓位：X成",
                "entry_plan": "分批建仓策略",
                "risk_control": "风控策略"
            },
            "action_checklist": [
                "✅/⚠️/❌ 检查项1：均线结构是否支持结论",
                "✅/⚠️/❌ 检查项2：入场位置与风险回报是否合理",
                "✅/⚠️/❌ 检查项3：量价是否配合",
                "✅/⚠️/❌ 检查项4：资金流向是否支持",
                "✅/⚠️/❌ 检查项5：估值/业绩是否匹配",
                "✅/⚠️/❌ 检查项6：消息面是否存在重大利空"
            ]
        }
    },
    "analysis_summary": "100字左右综合分析摘要（先给结论，再说依据）",
    "key_points": "3-5个核心看点，逗号分隔",
    "risk_warning": "风险提示",
    "sector_view": "所属板块/概念的强弱与联动判断"
}

## 评分标准（sentiment_score 与 action 必须同档）

### 强烈买入（80-100）/ action=buy
- ✅ 多个信号同时支持积极结论；上行空间、触发条件与风险回报清晰
- ✅ 关键风险已排查，仓位与止损计划明确

### 买入（60-79）/ action=add
- ✅ 主信号偏积极，仍有少量待确认项

### 观望（40-59）/ action=watch 或 hold
- ⚠️ 信号分歧较大，或缺乏足够确认；风险与机会大致均衡

### 减仓（20-39）/ action=reduce
- ⚠️ 主要结论转弱，风险明显高于收益

### 卖出（0-19）/ action=sell
- ❌ 触发止损/失效条件或重大利空，趋势显著恶化

## 决策仪表盘核心原则

1. **核心结论先行**：一句话说清该买该卖
2. **分持仓建议**：空仓者与持仓者给不同建议
3. **精确狙击点**：必须给出具体价格，不说“逢低吸纳”这类模糊话
4. **检查清单可视化**：用 ✅⚠️❌ 明确显示每一项结果
5. **风险优先级**：风险点要醒目标出

## 可操作性与稳定性约束

- 不得仅因为单日涨跌或评分跨线就在「买入/卖出」之间剧烈切换。
- 操作建议必须同时参考价格位置（支撑/压力）、量能、主力资金流向和风险事件。
- 股价位于支撑与压力之间、资金流不明确时，优先输出「持有/震荡/观望」这类可执行的中性建议，`decision_type` 保持 `hold`。
- 只有接近支撑确认或有效突破压力、且资金流与量价配合时才能给买入；接近压力且资金流出时不得追买。
- 只有跌破关键支撑、主力持续流出或风险显著放大时才能给卖出/减仓。
- **输入里标注「未纳入」的数据（新闻、资金流、筹码等），不得当作「已确认没有问题」**：`intelligence` 里要写明数据缺失，`confidence_level` 不得为高，`data_limitations` 也体现在 `analysis_summary` 或 `risk_warning` 里。
"""


def _money(value: Optional[float]) -> str:
    """元 → 亿/万，保留两位。数据缺失给「未纳入」。"""
    if value is None or value == "":
        return "未纳入"
    try:
        value = float(value)  # 东财有时给字符串
    except (TypeError, ValueError):
        return "未纳入"
    if abs(value) >= 1e8:
        return f"{value / 1e8:.2f}亿"
    if abs(value) >= 1e4:
        return f"{value / 1e4:.2f}万"
    return f"{value:.0f}"


def _num(value: Any, digits: int = 2) -> str:
    if value is None:
        return "未纳入"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return str(value)


def _tech_line(tech: dict[str, Any]) -> str:
    parts = []
    for key, label in (
        ("trend", "趋势"),
        ("macd", "MACD"),
        ("rsi", "RSI"),
        ("kdj", "KDJ"),
        ("boll", "BOLL"),
        ("volume", "量能"),
    ):
        value = tech.get(key)
        if value not in (None, ""):
            parts.append(f"{label}={value}")
    return "；".join(parts) if parts else "未纳入"


def build_user_prompt(
    *,
    snapshot: dict[str, Any],
    phase: dict[str, Any],
    boards: dict[str, Any],
    flow: dict[str, Any],
    news: dict[str, Any],
    limitations: list[str],
    announcements: Optional[dict[str, Any]] = None,
    margin: Optional[dict[str, Any]] = None,
    flash: Optional[dict[str, Any]] = None,
    research: Optional[dict[str, Any]] = None,
    billboard: Optional[dict[str, Any]] = None,
    popularity: Optional[dict[str, Any]] = None,
) -> str:
    """把取到的数据拼成事实表。缺什么，就在「数据缺口」里点名。"""
    name = snapshot.get("name") or snapshot.get("code")
    lines: list[str] = [
        "# 决策仪表盘分析请求",
        "",
        "## 股票基础信息",
        f"| 项目 | 数据 |",
        f"|------|------|",
        f"| 股票代码 | {snapshot.get('code')} |",
        f"| 股票名称 | {name} |",
        f"| 行情日期（库里最新一根） | {snapshot.get('asof')} |",
        f"| 市场阶段 | {phase.get('label')}（{phase.get('phase')}，{phase.get('market_local_time')}） |",
        "",
        "## 技术面数据（来源：本机行情库，单位：元）",
        "| 指标 | 数值 |",
        "|------|------|",
        f"| 收盘价 | {_num(snapshot.get('price'))} |",
        f"| 开盘价 | {_num(snapshot.get('open'))} |",
        f"| 最高价 | {_num(snapshot.get('high'))} |",
        f"| 最低价 | {_num(snapshot.get('low'))} |",
        f"| 昨收 | {_num(snapshot.get('pre_close'))} |",
        f"| 涨跌幅 | {_num(snapshot.get('change_pct'))}% |",
        f"| 成交额 | {_money(snapshot.get('amount'))} |",
        f"| 换手率 | {_num(snapshot.get('turnover_rate'))}% |",
        f"| 量比（日线口径近似） | {_num(snapshot.get('volume_ratio'))} |",
        f"| PE(TTM) | {_num(snapshot.get('pe_ttm'))} |",
        f"| PB | {_num(snapshot.get('pb'))} |",
        f"| 总市值 | {_money(snapshot.get('total_market_cap'))} |",
        f"| 流通市值 | {_money(snapshot.get('circulating_market_cap'))} |",
        "",
        "### 均线系统（已还原为不复权价，可直接与现价比较）",
        "| 均线 | 数值 |",
        "|------|------|",
        f"| MA5 | {_num(snapshot.get('ma5'))} |",
        f"| MA10 | {_num(snapshot.get('ma10'))} |",
        f"| MA20 | {_num(snapshot.get('ma20'))} |",
        f"| MA60 | {_num(snapshot.get('ma60'))} |",
        f"| 均线形态 | {snapshot.get('ma_alignment') or '未纳入'} |",
        f"| 5日乖离率 | {_num(snapshot.get('bias_ma5'))}% |",
        "",
        "### 区间统计",
        "| 指标 | 数值 |",
        "|------|------|",
        f"| 20日最高 / 最低 | {_num(snapshot.get('high_20'))} / {_num(snapshot.get('low_20'))} |",
        f"| 5日 / 20日 / 60日涨幅 | {_num(snapshot.get('ret_5d'))}% / {_num(snapshot.get('ret_20d'))}% / {_num(snapshot.get('ret_60d'))}% |",
        f"| 技术指标快照 | {_tech_line(snapshot.get('tech') or {})} |",
        f"| 技术面支撑 / 压力 | {_num((snapshot.get('tech') or {}).get('support'))} / {_num((snapshot.get('tech') or {}).get('resistance'))} |",
        "",
        "## 板块归属（来源：东财公开接口）",
    ]

    if boards.get("available"):
        lines.append(f"- 行业：{boards.get('industry') or '未纳入'}")
        lines.append(f"- 地区：{boards.get('region') or '未纳入'}")
        lines.append(f"- 概念：{'、'.join(boards.get('concepts') or []) or '未纳入'}")
    else:
        lines.append(f"- 未纳入（{boards.get('reason') or '板块数据不可用'}）")

    lines += ["", "## 主力资金流（来源：东财，单位：元）"]
    if flow.get("available"):
        latest = flow.get("latest") or {}
        lines.append(
            f"- {latest.get('date')} 主力净流入 {_money(latest.get('main_net'))}"
            f"（占比 {_num(latest.get('main_net_pct'))}%），超大单 {_money(latest.get('super_large_net'))}，"
            f"大单 {_money(latest.get('large_net'))}"
        )
        recent = flow.get("recent") or []
        if len(recent) > 1:
            seq = "、".join(f"{r.get('date')[-5:]} {_money(r.get('main_net'))}" for r in recent)
            lines.append(f"- 近{len(recent)}个交易日主力净流入：{seq}")
            lines.append(f"- 近{len(recent)}日合计：{_money(flow.get('sum_main_net'))}")
    else:
        lines.append(f"- 未纳入（{flow.get('reason') or '资金流不可用'}）")

    lines += ["", "## 消息面（东财新闻搜索，按时间倒序）"]
    if news.get("available"):
        for item in (news.get("items") or [])[:12]:
            lines.append(f"- [{item.get('date')}] {item.get('title')}｜{item.get('summary')}")
    else:
        lines.append(f"- 未纳入（{news.get('reason') or '没有搜到相关新闻'}）")

    ann = announcements or {}
    lines += ["", "## 公司公告（来源：东财公告接口）"]
    if ann.get("available"):
        for item in (ann.get("items") or [])[:8]:
            lines.append(f"- [{item.get('date')}]（{item.get('event')}）{item.get('title')}")
    else:
        lines.append(f"- 未纳入（{ann.get('reason') or '公告未取到'}）")

    mg = margin or {}
    lines += ["", "## 融资融券（来源：东财数据中心，单位：元）"]
    if mg.get("available"):
        lines.append(
            f"- {mg.get('date')} 融资余额 {_money(mg.get('financing_balance'))}，"
            f"当日融资买入 {_money(mg.get('financing_buy'))}"
        )
        lines.append(
            f"- 融券余额 {_money(mg.get('lending_balance'))}，"
            f"两融余额合计 {_money(mg.get('total_balance'))}"
        )
    else:
        lines.append(f"- 未纳入（{mg.get('reason') or '两融未取到'}）")

    fl = flash or {}
    lines += ["", "## 7×24 快讯（来源：财联社）"]
    if fl.get("available"):
        if fl.get("mode") == "stock":
            lines.append("- 以下快讯提到了本股：")
        else:
            lines.append(
                "- 以下为大盘/行业快讯，**未提及本股**：只能当市场背景，不得写成这只票的消息"
            )
        for item in (fl.get("items") or [])[:6]:
            lines.append(f"- [{item.get('time')}][{item.get('level')}级] {item.get('title')}")
    else:
        lines.append(f"- 未纳入（{fl.get('reason') or '快讯未取到'}）")

    rs = research or {}
    lines += ["", "## 机构研报与评级（来源：东财研报中心，近一年）"]
    if rs.get("available"):
        lines.append(f"- 近一年研报数：{rs.get('hits')}")
        if rs.get("ratings"):
            dist = "、".join(f"{k} {v} 篇" for k, v in rs["ratings"].items())
            lines.append(f"- 评级分布：{dist}")
        for item in (rs.get("items") or [])[:5]:
            extra = []
            if item.get("target_price"):
                extra.append(f"目标价 {_num(item.get('target_price'))} 元")
            if item.get("pe_this_year"):
                extra.append(f"今年预测PE {_num(item.get('pe_this_year'))}")
            tail = f"（{'，'.join(extra)}）" if extra else ""
            lines.append(
                f"- [{item.get('date')}] {item.get('org')}"
                f"《{item.get('title')}》评级：{item.get('rating') or '未给出'}{tail}"
            )
        lines.append("- 研报是卖方观点，只能当情绪与预期参考，不得当成价格依据。")
    else:
        lines.append(f"- 未纳入（{rs.get('reason') or '研报未取到'}）")

    bb = billboard or {}
    lines += ["", "## 龙虎榜（来源：东财数据中心，单位：元）"]
    if bb.get("available"):
        for item in (bb.get("items") or [])[:5]:
            lines.append(
                f"- [{item.get('date')}] 上榜原因：{item.get('reason')}；"
                f"榜单净买入 {_money(item.get('net_buy'))}，买入 {_money(item.get('buy'))}，"
                f"卖出 {_money(item.get('sell'))}；当日涨跌 {_num(item.get('change_pct'))}%；"
                f"上榜后5日 {_num(item.get('d5_return'))}%"
                + (f"；备注：{item.get('note')}" if item.get("note") else "")
            )
    else:
        lines.append(f"- 未纳入（{bb.get('reason') or '龙虎榜未取到'}）")

    pop = popularity or {}
    lines += ["", "## 人气排名（来源：东财人气榜，替代需 apikey 的社交情绪）"]
    if pop.get("available"):
        if pop.get("rank"):
            lines.append(f"- 全市场人气排名：第 {pop.get('rank')} 名（样本：前 {pop.get('scope')} 名）")
        else:
            lines.append(
                f"- 不在当日人气榜前 {pop.get('scope')} 名（榜单只公开前 {pop.get('scope')} 名，"
                "**不代表没有讨论，也不能据此说情绪高涨**）"
            )
    else:
        lines.append(f"- 未纳入（{pop.get('reason') or '人气榜未取到'}）")

    lines += ["", "## 数据缺口（必须写进报告，不得当作“已确认无风险”）"]
    if limitations:
        lines += [f"- {x}" for x in limitations]
    else:
        lines.append("- 无（本次数据齐备）")

    lines += [
        "",
        "## 要求",
        f"- 现价以 {_num(snapshot.get('price'))} 元为基准，所有点位都必须是具体价格（元）。",
        "- 直接输出 JSON，不要代码块围栏。",
    ]
    return "\n".join(lines)
