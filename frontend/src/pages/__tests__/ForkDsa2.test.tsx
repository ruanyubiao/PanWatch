/**
 * 深度分析2 页面：只钉「截图里那块 UI 是否照字段渲染出来」。
 *
 * 接口全部 mock —— 这个页面自己不发网络请求以外的判断，真实取数在服务端测过
 * （``tests/test_fork_dsa.py``）。这里关注的是容易在改样式时弄坏的地方：
 * 核心洞察、操作建议/趋势预测、板块标签、四张狙击点位卡、情绪环数字与档位文案。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ForkDsa2Page from '../ForkDsa2'
// ?raw：JSON 原样当字符串读进来，既不用开 resolveJsonModule，也不会被 i18n 检查当成待翻译文案
import realRowRaw from './fixtures/dsa2-600519.json?raw'

/**
 * 真实报告 payload —— 云端 600519（贵州茅台）那份，原样抄下来当回归夹具。
 *
 * 为什么用真数据：mock 掉接口的用例永远造不出「真的模型输出长什么样」，字段名错、
 * 缺字段、文案里带旧口径（未配置 / 需 apikey）这类问题只有真 payload 能暴露。
 * 重新抓取方式：服务器 dsa_reports 表取 symbol=600519 最新 done 行的 payload。
 */
const realRow600519: unknown = JSON.parse(realRowRaw)

const report = {
  meta: {
    stock_code: '002256',
    stock_name: '兆新股份',
    current_price: 2.93,
    change_pct: 0.34,
    asof: '2026-10-19',
    created_at: '2026-10-19T16:34:58',
    market_phase: 'postmarket',
    market_phase_label: '盘后',
    model_used: 'test/model',
  },
  summary: {
    analysis_summary: '兆新股份当前处于空头排列，股价低于所有均线，建议观望。',
    operation_advice: '观望',
    action_label: '观望',
    trend_prediction: '看空',
    sentiment_score: 42,
    sentiment_label: '中性',
    confidence_level: '中',
    risk_warning: '跌破 2.85 元需要止损。',
  },
  strategy: {
    ideal_buy: '空头排列下暂无理想买入点',
    secondary_buy: '暂无，需等待趋势反转',
    stop_loss: '2.85元（今日低点下方约1%）',
    take_profit: '3.05元（MA5附近）',
  },
  details: {
    sectors: ['光伏发电', '电力', '绿色电力'],
    limitations: ['新闻面未纳入（东财新闻搜索无结果或不可用）'],
    data_sources: ['本机行情库', '东财板块归属'],
  },
}

const latest = vi.fn()
const getReport = vi.fn()
const analyze = vi.fn()
const getQueue = vi.fn()

vi.mock('@/lib/dsa-api', async () => {
  // 纯格式化/计时函数保留真实实现（本文件要钉的正是显示口径），只把网络调用换成 mock。
  const actual = await vi.importActual<typeof import('@/lib/dsa-api')>('@/lib/dsa-api')
  return {
    ...actual,
    DSA_POLL_MS: 999999,
    getDsaLatest: (...args: unknown[]) => latest(...args),
    getDsaReport: (...args: unknown[]) => getReport(...args),
    analyzeDsa: (...args: unknown[]) => analyze(...args),
    getDsaQueue: (...args: unknown[]) => getQueue(...args),
    deleteDsaQueueItem: vi.fn(),
    getDsaHistory: vi.fn(),
  }
})

function renderPage(symbol = '002256', name = '%E5%85%86%E6%96%B0%E8%82%A1%E4%BB%BD') {
  return render(
    <MemoryRouter initialEntries={[`/dsa2/${symbol}?name=${name}`]}>
      <Routes>
        <Route path="/dsa2/:symbol" element={<ForkDsa2Page />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('深度分析2 页面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latest.mockResolvedValue({
      id: 7,
      symbol: '002256',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report,
    })
  })

  it('渲染截图那块面板的全部字段', async () => {
    renderPage()
    expect(await screen.findByText('兆新股份')).toBeTruthy()
    expect(screen.getByText('2.93')).toBeTruthy()
    expect(screen.getByText('+0.34%')).toBeTruthy()
    expect(screen.getByText('核心洞察')).toBeTruthy()
    expect(screen.getAllByText(/空头排列/).length).toBeGreaterThan(0)
    expect(screen.getByText('操作建议')).toBeTruthy()
    expect(screen.getByText('趋势预测')).toBeTruthy()
    expect(screen.getByText('看空')).toBeTruthy()
    // 板块标签逐个渲染
    expect(screen.getByText('光伏发电')).toBeTruthy()
    expect(screen.getByText('绿色电力')).toBeTruthy()
    // 四张狙击点位卡
    expect(screen.getByText('理想买入')).toBeTruthy()
    expect(screen.getByText('二次买入')).toBeTruthy()
    expect(screen.getByText('止损价位')).toBeTruthy()
    expect(screen.getByText('止盈目标')).toBeTruthy()
    expect(screen.getByText(/2.85元/)).toBeTruthy()
    // 情绪环：42 与档位文案
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('中性')).toBeTruthy()
    // 数据缺口要明说
    expect(screen.getByText(/新闻面未纳入/)).toBeTruthy()
  })

  it('没有历史报告时不自作主张：停在「开始分析」，点按钮才起任务', async () => {
    latest.mockResolvedValue({ id: null, symbol: '002256', status: 'none', report: null })
    analyze.mockResolvedValue({ id: 8, symbol: '002256', status: 'running', report: null })
    renderPage()
    expect(await screen.findByText('开始分析')).toBeTruthy()
    // 打开页面不能自己烧一次模型
    expect(analyze).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('开始分析'))
    await waitFor(() => expect(analyze).toHaveBeenCalledWith('002256', '兆新股份'))
    expect(await screen.findByText('正在生成决策报告…')).toBeTruthy()
  })

  it('失败时给出错误与重试入口', async () => {
    latest.mockResolvedValue({
      id: 9,
      symbol: '002256',
      status: 'failed',
      error: 'RuntimeError: 行情库炸了',
      report: null,
    })
    renderPage()
    expect(await screen.findByText('分析失败')).toBeTruthy()
    expect(screen.getByText(/行情库炸了/)).toBeTruthy()
    expect(screen.getAllByText('重新分析').length).toBeGreaterThan(0)
  })

  it('数据源面板：需要 apikey 的模块整行不出现，接口失败的折叠成一行（老报告也挡掉）', async () => {
    latest.mockResolvedValue({
      id: 11,
      symbol: '002256',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report: {
        ...report,
        details: {
          ...report.details,
          sources: [
            { key: 'market', label: '行情 / 均线 / 技术指标', source: '本机行情库 MySQL', status: 'ok' },
            { key: 'announcements', label: '公司公告', source: '东财公告接口', status: 'unavailable' },
            { key: 'research', label: '研报 / 机构评级', source: null, requires_key: true, status: 'unconfigured' },
            { key: 'social', label: '社交情绪', source: null, requires_key: true, status: 'unconfigured' },
          ],
        },
      },
    })
    renderPage()
    expect(await screen.findByText('数据源')).toBeTruthy()
    // 有数据的照常列出
    expect(screen.getByText('已接入')).toBeTruthy()
    expect(document.querySelector('[data-dsa2-source="market"]')).toBeTruthy()
    // 「未配置」这一档整行消失，页面上一个字都不留
    expect(screen.queryByText('未配置')).toBeNull()
    expect(document.querySelector('[data-dsa2-source="research"]')).toBeNull()
    expect(document.querySelector('[data-dsa2-source="social"]')).toBeNull()
    // 接口失败的不逐条报警，折叠成一行安静的汇总
    expect(document.querySelector('[data-dsa2-source="announcements"]')).toBeNull()
    const failed = document.querySelector('[data-dsa2-sources-failed]')
    expect(failed?.getAttribute('data-dsa2-sources-failed')).toBe('1')
    expect(failed?.textContent).toContain('公司公告')
    expect(failed?.textContent).toContain('另 1 项本次未取到')
  })

  it('全部源都是 unconfigured 时（最老那种报告）整块面板不渲染', async () => {
    latest.mockResolvedValue({
      id: 13,
      symbol: '002256',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report: {
        ...report,
        details: {
          ...report.details,
          sources: [
            { key: 'research', label: '研报', source: null, status: 'unconfigured' },
            { key: 'social', label: '社交情绪', source: null, status: 'unconfigured' },
          ],
        },
      },
    })
    renderPage()
    expect(await screen.findByText('兆新股份')).toBeTruthy()
    expect(document.querySelector('[data-dsa2-sources]')).toBeNull()
  })

  it('老报告没有数据源清单时不渲染面板（不留一堆假的未配置）', async () => {
    renderPage()
    expect(await screen.findByText('兆新股份')).toBeTruthy()
    expect(document.querySelector('[data-dsa2-sources]')).toBeNull()
  })

  it('空结果行显示「近一年未上榜」并带上最近一次上榜日期（不是「本次未取到」）', async () => {
    latest.mockResolvedValue({
      id: 12,
      symbol: '600519',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report: {
        ...report,
        details: {
          ...report.details,
          sources: [
            {
              key: 'billboard',
              label: '龙虎榜',
              source: '东财数据中心（免 key）',
              status: 'empty',
              empty_label: '近一年未上榜',
              note: '近一年未上榜，最近一次 2013-01-28，13 年前',
            },
          ],
        },
      },
    })
    renderPage()
    expect(await screen.findByText('近一年未上榜')).toBeTruthy()
    expect(screen.getByText(/最近一次 2013-01-28/)).toBeTruthy()
    expect(screen.queryByText('本次未取到')).toBeNull()
  })

  it('北交所标的：页面只给一句话，一个请求都不发、也不给「开始分析」', async () => {
    renderPage('920992', '%E4%B8%AD%E7%A7%91%E7%BE%8E%E8%8F%B1')
    expect(await screen.findByText('北交所标的不在股票池内')).toBeTruthy()
    expect(screen.getByText(/北交所（bj \/ 4xx \/ 8xx \/ 920xxx）一律排除/)).toBeTruthy()
    expect(document.querySelector('[data-dsa2-bj-blocked="1"]')).toBeTruthy()
    // 不读历史、不起任务、不出现「开始分析」按钮
    expect(latest).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
    expect(screen.queryByText('开始分析')).toBeNull()
  })
})

describe('真实 payload 回归（云端 600519 那份原样回放）', () => {
  it('页面完整渲染：不报错、不出现「未配置」，四张点位卡与数据源面板都在', async () => {
    latest.mockResolvedValue(realRow600519)
    renderPage('600519', '%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0')
    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    // 不报错
    expect(screen.queryByText(/读取报告失败/)).toBeNull()
    expect(document.querySelector('[data-dsa2-sources]')).toBeTruthy()
    expect(screen.queryByText('未配置')).toBeNull()
    // 截图红框里的四块都在
    expect(document.querySelector('[data-dsa2-core]')).toBeTruthy()
    for (const label of ['理想买入', '二次买入', '止损价位', '止盈目标']) {
      expect(document.querySelector(`[data-dsa2-sniper="${label}"]`)).toBeTruthy()
    }
    // 模型口径写的是 PanWatch 那套配置里的模型名
    expect(screen.getByText(/腾讯\/hy4/)).toBeTruthy()
    // 数据源面板里每一项都有状态（没有未配置这一档）
    for (const node of Array.from(document.querySelectorAll('[data-dsa2-source-status]'))) {
      expect(node.getAttribute('data-dsa2-source-status')).not.toBe('unconfigured')
    }
  })
})

describe('股票池排除北交所', () => {
  it('isBeijingCode 认 bj / 4xx / 8xx / 920xxx，不误伤沪深主板与创业板', async () => {
    const actual = await vi.importActual<typeof import('@/lib/dsa-api')>('@/lib/dsa-api')
    const { isBeijingCode } = actual
    for (const code of ['920992', 'bj920992', '920992.BJ', '830799', '430047', '870199', '430047.BJ']) {
      expect(isBeijingCode(code)).toBe(true)
    }
    for (const code of ['600519', 'sh600519', '600519.SH', '002256', 'sz002256', '300750', '000975']) {
      expect(isBeijingCode(code)).toBe(false)
    }
    expect(isBeijingCode('')).toBe(false)
    expect(isBeijingCode(null)).toBe(false)
    expect(isBeijingCode(undefined)).toBe(false)
  })
})
