/**
 * 深度分析2 的两块「证据」：技术面（K线/技术指标）与模型预测。
 *
 * 这里钉的是**时点口径**，不是样式 —— 用户的原话是「报告可能是 3 天前的，我今天
 * 打开，不能给我今天的数据」。所以每个用例都围绕「这块数是从哪来的」：
 *   - payload 里有 → 直接用，一个请求都不发；
 *   - payload 里没有（旧报告）→ 按报告的基准日去复原，但请求必须带上 asof；
 *   - 都拿不到 → 如实写「没有数据」，不许编数字，也不许静默取今天的。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dsa2TechnicalPanel } from '../Dsa2TechnicalPanel'
import { Dsa2PredictPanel, PREDICT_EFFECTIVE_PCT } from '../Dsa2PredictPanel'
import type { DsaTechnical } from '@/lib/dsa-api'

const getDsaTechnical = vi.fn()
const getPredictStock = vi.fn()

vi.mock('@/lib/dsa-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dsa-api')>('@/lib/dsa-api')
  return {
    ...actual,
    getDsaTechnical: (...args: unknown[]) => getDsaTechnical(...args),
  }
})

vi.mock('@/lib/predict-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/predict-api')>('@/lib/predict-api')
  return {
    ...actual,
    getPredictStock: (...args: unknown[]) => getPredictStock(...args),
  }
})

/** 云端 000975（山金国际）2026-11-24 那份报告里的技术面块，字段照抄。 */
const technical: DsaTechnical = {
  available: true,
  code: '000975',
  asof: '2026-11-24',
  captured_at: '2026-11-25 10:21:00',
  bar_close: 21.04,
  price: 21.6,
  intraday: true,
  score: -4,
  trend: '空头排列，趋势偏弱',
  macd: 'MACD 死叉，短线动能转弱',
  rsi: 'RSI 中性',
  kdj: 'KDJ 金叉，短线转强',
  boll: 'BOLL 开口放大',
  volume: '平量',
  support: 19.53,
  resistance: 25.66,
  ma: { ma5: 21.08, ma10: 21.84, ma20: 22.38, ma60: 24.1 },
  volume_ratio: 0.73,
  high_20: 23.5,
  low_20: 19.5,
  ret_5d: -2.1,
  ret_20d: -8.4,
  ret_60d: -12.0,
}

describe('技术面区（与报告一起保存）', () => {
  it('payload 里有快照就直接渲染，且一个请求都不发', async () => {
    getDsaTechnical.mockClear()
    render(<Dsa2TechnicalPanel technical={technical} symbol="000975" reportAsof="2026-11-24" />)

    expect(screen.getByText('K线 / 技术指标')).toBeTruthy()
    // 日期必须是报告里那份（2026-11-24），不是今天
    expect(screen.getByText('数据截至 2026-11-24')).toBeTruthy()
    expect(screen.getByText('报告内保存')).toBeTruthy()
    // 评分与各项明细：库里 tech_score = -4
    expect(screen.getByText(/评分 -4/)).toBeTruthy()
    // 逐项明细里必须出现「均线空头排列」这一条（-2）；摘要行里也会出现，所以用 getAll
    expect(screen.getAllByText(/均线空头排列/).length).toBeGreaterThan(0)
    expect(screen.getByText('KDJ 金叉，短线转强')).toBeTruthy()
    // 支撑/压力 pill
    expect(screen.getByText(/19\.53/)).toBeTruthy()
    expect(screen.getByText(/25\.66/)).toBeTruthy()
    expect(getDsaTechnical).not.toHaveBeenCalled()
  })

  it('旧报告没有快照：按报告的基准日复原，请求必须带 asof', async () => {
    getDsaTechnical.mockReset()
    getDsaTechnical.mockResolvedValue({ ...technical, reconstructed: true })

    render(<Dsa2TechnicalPanel technical={null} symbol="000975" reportAsof="2026-11-24" />)

    await waitFor(() => expect(screen.getByText('按报告基准日复原')).toBeTruthy())
    expect(getDsaTechnical).toHaveBeenCalledWith('000975', '2026-11-24')
    // 复原出来的仍是那一天的数
    expect(screen.getByText('数据截至 2026-11-24')).toBeTruthy()
    expect(screen.getByText(/评分 -4/)).toBeTruthy()
  })

  it('复原失败：如实写「没有技术面数据」，不编数字', async () => {
    getDsaTechnical.mockReset()
    getDsaTechnical.mockRejectedValue(new Error('行情库连不上'))

    render(<Dsa2TechnicalPanel technical={null} symbol="000975" reportAsof="2026-11-24" />)

    await waitFor(() => expect(screen.getByText('这份报告没有技术面数据')).toBeTruthy())
    expect(screen.getByText(/行情库连不上/)).toBeTruthy()
    expect(screen.queryByText(/评分/)).toBeNull()
  })

  it('技术指标本来就没有（新股）：写出原因，不把 0 分当观望', async () => {
    render(
      <Dsa2TechnicalPanel
        technical={{ available: false, reason: '这只票没有技术指标（新股或日线不足 120 根）' }}
        symbol="301999"
        reportAsof="2026-11-24"
      />,
    )
    expect(screen.getByText('这份报告没有技术面数据')).toBeTruthy()
    expect(screen.getByText(/新股或日线不足 120 根/)).toBeTruthy()
    expect(screen.queryByText(/评分 0/)).toBeNull()
  })
})

describe('模型预测区（时点 + 有效区）', () => {
  const inZone = {
    available: true,
    code: '600519',
    trade_date: '2026-11-24',
    rank_no: 12,
    universe: 4991,
    pct: 99.76,
    model_version: 'v20261123',
  }

  it('payload 里有预测：显示名次/分位，落在前 10% 判为有效区', () => {
    getPredictStock.mockClear()
    render(<Dsa2PredictPanel prediction={inZone} symbol="600519" reportAsof="2026-11-24" />)

    expect(screen.getByText('#12')).toBeTruthy()
    expect(screen.getByText('99.76')).toBeTruthy()
    expect(screen.getByText('在有效区（前 10%）')).toBeTruthy()
    // 有效区的解读必须写「不是买入信号」
    expect(screen.getByText(/不是买入信号/)).toBeTruthy()
    expect(getPredictStock).not.toHaveBeenCalled()
  })

  it('不在前 10% 时明确写「无信息，不是看空」', () => {
    render(
      <Dsa2PredictPanel
        prediction={{ ...inZone, rank_no: 4028, pct: 19.31 }}
        symbol="000975"
        reportAsof="2026-11-24"
      />,
    )
    expect(screen.getByText('#4028')).toBeTruthy()
    expect(screen.getByText('不在有效区（无信息）')).toBeTruthy()
    expect(screen.getByText(/不能说它在看空/)).toBeTruthy()
  })

  it('阈值就是分位 90（前 10%）：89.99 不算，90 算', () => {
    expect(PREDICT_EFFECTIVE_PCT).toBe(90)
    const { rerender } = render(
      <Dsa2PredictPanel prediction={{ ...inZone, pct: 89.99 }} symbol="600519" reportAsof="2026-11-24" />,
    )
    expect(screen.getByText('不在有效区（无信息）')).toBeTruthy()
    rerender(<Dsa2PredictPanel prediction={{ ...inZone, pct: 90 }} symbol="600519" reportAsof="2026-11-24" />)
    expect(screen.getByText('在有效区（前 10%）')).toBeTruthy()
  })

  it('旧报告没有预测快照：按报告基准日在预测历史里找同一天那条', async () => {
    getPredictStock.mockReset()
    getPredictStock.mockResolvedValue({
      code: '000975',
      name: '山金国际',
      trade_date: '2026-11-24',
      rank_no: 4028,
      universe: 4991,
      pct: 19.31,
      history: [
        { trade_date: '2026-11-21', rank_no: 4200, pct: 15.8 },
        { trade_date: '2026-11-24', rank_no: 4028, pct: 19.31 },
      ],
    })

    render(<Dsa2PredictPanel prediction={null} symbol="000975" reportAsof="2026-11-24" />)

    await waitFor(() => expect(screen.getByText('#4028')).toBeTruthy())
    expect(getPredictStock).toHaveBeenCalledWith('000975', 60)
    // 找到同一天的 → 标「与本报告同一交易日」，不能标成「非本报告时点」
    expect(screen.getByText('与本报告同一交易日')).toBeTruthy()
    expect(screen.queryByText(/非本报告时点/)).toBeNull()
  })

  it('历史里没有那一天：退回最新一条，但必须标「非本报告时点」', async () => {
    getPredictStock.mockReset()
    getPredictStock.mockResolvedValue({
      code: '000975',
      trade_date: '2026-11-25',
      rank_no: 3900,
      universe: 4991,
      pct: 21.9,
      history: [
        { trade_date: '2026-11-24', rank_no: 4028, pct: 19.31 },
        { trade_date: '2026-11-25', rank_no: 3900, pct: 21.9 },
      ],
    })

    render(<Dsa2PredictPanel prediction={null} symbol="000975" reportAsof="2026-11-23" />)

    await waitFor(() => expect(screen.getByText('#3900')).toBeTruthy())
    expect(screen.getByText(/非本报告时点/)).toBeTruthy()
    expect(screen.queryByText('与本报告同一交易日')).toBeNull()
  })

  it('没有预测记录：写出可能的原因，不显示 0 名次', async () => {
    getPredictStock.mockReset()
    getPredictStock.mockRejectedValue(new Error('未找到'))

    render(<Dsa2PredictPanel prediction={null} symbol="920992" reportAsof="2026-11-24" />)

    await waitFor(() => expect(screen.getByText('这只票没有预测记录')).toBeTruthy())
    expect(screen.getByText(/每日 17:00 同步后计算/)).toBeTruthy()
    expect(screen.queryByText(/#0/)).toBeNull()
  })
})
