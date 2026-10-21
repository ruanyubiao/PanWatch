import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { StockMarketTable, MARKET_FETCH_LIMIT } from '@/components/fork/StockMarketTable'
import { EMPTY_MARKET_FILTERS } from '@/lib/market-filters'
import type { MarketRow, MarketRowRaw, MarketTablePayload } from '@/lib/fork-kline-summary'

vi.mock('@panwatch/api', () => ({ fetchAPI: vi.fn() }))

/**
 * fork 分析页的行表格。这里钉住用户明确要求过的事：
 *   1. 列的**顺序与名称**（市场 代码 名称 昨收价 现价 涨跌 最高价 最低价 成交量 成交额 换手率 总市值 状态 指标 来源 操作）
 *   2. 数据**只**来自 /stocks/market-table —— 再也不发 /quotes/batch 与
 *      /klines/summary/batch（那两条就是「查外网次数太多被屏蔽」的元凶）
 *   3. 市场列只出 沪/深/北
 *   4. **全量取一次**，此后筛选/排序/翻页/搜索全在前端（不再打接口）
 *   5. 表头可排序，「状态」按库里 tech_score 排、无分恒排最后
 *   6. 分页条上下各一条：上一条左侧是「工具条按钮 + 50px + 搜索框」，下一条只有页码区
 */

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  code: '600519',
  symbol: 'sh600519',
  exchange: 'SH',
  name: '贵州茅台',
  board: 'sh',
  trade_date: '2026-10-14',
  pre_close: 1286.0,
  close: 1290.5,
  high: 1299,
  low: 1276.02,
  change_pct: 0.35,
  volume: 58855939,
  amount: 15252457670,
  turnover_rate: 1.3814,
  total_market_cap: 1607604938886,
  source: 'sina',
  ma: { ma5: 1280, ma10: 1270, ma20: 1250, ma60: 1200 },
  tech: {
    score: 6,
    trend: '多头排列',
    macd: '金叉(5日)',
    rsi: '偏强',
    kdj: '金叉',
    boll: '正常波动',
    volume: '平量',
    support: 1250,
    resistance: 1300,
  },
  ...over,
})

/** 三只票（**按代码升序**，与后端 ORDER BY code 的口径一致）：深→沪→北，北交所那只无 tech_* */
const threeRows = (): MarketRow[] => [
  row({
    code: '000001',
    symbol: 'sz000001',
    exchange: 'SZ',
    name: '平安银行',
    board: 'sz',
    close: 11.59,
    change_pct: -1.61,
    total_market_cap: 224914591914.82,
    tech: { ...row().tech!, score: -3 },
  }),
  row(),
  row({
    code: '920000',
    symbol: 'bj920000',
    exchange: 'BJ',
    name: '安徽凤凰',
    board: 'other',
    close: 12.3,
    pre_close: 12.5,
    change_pct: -1.6,
    high: 12.6,
    low: 12.2,
    total_market_cap: 1000000000,
    tech: null,
  }),
]

/**
 * 接口返回的是**短名**行（字段名 1–2 个字母，见 `MarketRowRaw`）。
 * 这里把测试用的可读行转成线上真实的形状，组件里的解析器才会真的被跑到。
 */
const toRaw = (r: MarketRow): MarketRowRaw => ({
  c: r.code,
  s: r.symbol,
  e: r.exchange,
  n: r.name,
  b: r.board,
  d: r.trade_date,
  pc: r.pre_close,
  cl: r.close,
  h: r.high,
  l: r.low,
  cp: r.change_pct,
  mc: r.total_market_cap,
  v: r.volume,
  am: r.amount,
  tr: r.turnover_rate,
  so: r.source,
  sc: r.status_code ?? null,
  sl: r.status_label ?? null,
  sg: r.status_group ?? null,
  m: { '5': r.ma.ma5, '10': r.ma.ma10, '20': r.ma.ma20, '60': r.ma.ma60 },
  t: r.tech
    ? {
        s: r.tech.score,
        t: r.tech.trend,
        m: r.tech.macd,
        r: r.tech.rsi,
        k: r.tech.kdj,
        b: r.tech.boll,
        v: r.tech.volume,
        su: r.tech.support,
        re: r.tech.resistance,
      }
    : null,
})

const response = (items: MarketRow[] = threeRows()): MarketTablePayload => ({
  a: '2026-10-14',
  i: items.map(toRaw),
})

const renderTable = (props: Partial<React.ComponentProps<typeof StockMarketTable>> = {}) => {
  const onAdd = vi.fn()
  const onRemove = vi.fn()
  const onCounts = vi.fn()
  const onOpenDetail = vi.fn()
  render(
    <StockMarketTable
      board="all"
      query=""
      existingSymbols={new Set<string>()}
      onCounts={onCounts}
      onAdd={onAdd}
      onRemove={onRemove}
      onOpenDetail={onOpenDetail}
      renderIndicator={r => <span>状态-{r.code}</span>}
      renderSource={r => <span>技术指标 · {r.trade_date?.slice(5)}</span>}
      renderActions={(r, state) => (
        <button onClick={() => (state.followed ? state.onUnfollow() : state.onFollow())}>
          操作-{r.code}
        </button>
      )}
      {...props}
    />,
  )
  return { onAdd, onRemove, onCounts, onOpenDetail }
}

const urlsOf = () => vi.mocked(fetchAPI).mock.calls.map(call => String(call[0]))

/** 表格里第 n 行的代码列文本（用于验证排序结果）。 */
const codesInOrder = (): string[] =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map(node => within(node).getAllByRole('cell')[1].textContent?.trim() || '')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('fork: 分析页全市场表格', () => {
  it('表头顺序与用户给的列序完全一致', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const table = screen.getByRole('table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(node => node.textContent?.trim())
    expect(headers).toEqual([
      '市场',
      '代码',
      '名称',
      '昨收价',
      '现价',
      '涨跌',
      '最高价',
      '最低价',
      '成交量',
      '成交额',
      '换手率',
      '总市值',
      '状态',
      '指标',
      '来源',
      '操作',
    ])
  })

  it('成交量/成交额/换手率：排在总市值前面，成交量折成万手、成交额折成亿、换手率补 %', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(
      response([row({ code: '600519', volume: 58855939, amount: 15252457670, turnover_rate: 1.3814 })]),
    )
    renderTable()
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    const table = screen.getByRole('table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(node => node.textContent?.trim())
    // 「放总市值前面」= 三列都排在总市值之前，且顺序是成交量 → 成交额 → 换手率
    expect(headers.indexOf('成交量')).toBeLessThan(headers.indexOf('总市值'))
    expect(headers.indexOf('成交额')).toBe(headers.indexOf('成交量') + 1)
    expect(headers.indexOf('换手率')).toBe(headers.indexOf('成交额') + 1)
    expect(headers.indexOf('总市值')).toBe(headers.indexOf('换手率') + 1)

    // 58,855,939 股 = 588,559.39 手 = 58.86 万手
    expect(screen.getByText('58.86万手')).toBeTruthy()
    expect(screen.getByText('152.52亿')).toBeTruthy()
    expect(screen.getByText('1.38%')).toBeTruthy()
    // 原始股数在 title 里（用户能核对单位）
    expect(screen.getByText('58.86万手').getAttribute('title')).toContain('58,855,939 股')
  })

  it('成交额列可排序（三态循环作用在全量上）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(
      response([
        row({ code: '000001', name: '平安银行', amount: 3e9 }),
        row({ code: '600519', name: '贵州茅台', amount: 1.5e10 }),
        row({ code: '920000', name: '安徽凤凰', amount: 2e7 }),
      ]),
    )
    renderTable()
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    const codesInOrder = () =>
      Array.from(screen.getByRole('table').querySelectorAll('tbody tr')).map(tr =>
        tr.querySelector('td:nth-child(2)')?.textContent?.trim(),
      )

    const sortBtn = screen.getByRole('button', { name: '按成交额排序' })
    await userEvent.click(sortBtn) // 未排序 → 降序
    expect(codesInOrder()).toEqual(['600519', '000001', '920000'])
    await userEvent.click(sortBtn) // 降序 → 升序
    expect(codesInOrder()).toEqual(['920000', '000001', '600519'])
    await userEvent.click(sortBtn) // 升序 → 取消（回到代码升序）
    expect(codesInOrder()).toEqual(['000001', '600519', '920000'])
  })

  it('状态列：跟在总市值后面、固定 68px；没注入渲染器时直接显示短标签', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(
      response([
        row({ code: '600519' }),
        row({ code: '000001', name: '平安银行', status_code: 'SUSPENDED', status_label: '停牌' }),
        row({ code: '920000', name: '安徽凤凰', status_code: 'ST', status_label: 'ST' }),
      ]),
    )
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const table = screen.getByRole('table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(node => node.textContent?.trim())
    // 紧跟在「总市值」后面
    expect(headers.indexOf('状态')).toBe(headers.indexOf('总市值') + 1)

    // 列宽固定：68px（「停牌 / 正常 / *ST」都在 3 个字以内）
    const col = table.querySelectorAll('colgroup col')[headers.indexOf('状态')] as HTMLElement
    expect(col.style.width).toBe('68px')

    // 正常（没有状态行）/ 停牌 / ST 三种都出得来
    expect(screen.getAllByText('正常').length).toBeGreaterThan(0)
    expect(screen.getByText('停牌')).toBeTruthy()
    expect(screen.getByText('ST')).toBeTruthy()
  })

  it('列宽：市场～总市值一律固定宽（各 −10）、名称 60 / 指标 120（左内边距 20）/ 操作 220', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response([row({ code: '600519' })]))
    renderTable()
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    const table = screen.getByRole('table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(node => node.textContent?.trim())
    const widthOf = (label: string) =>
      (table.querySelectorAll('colgroup col')[headers.indexOf(label)] as HTMLElement).style.width

    // 市场 → 总市值：全部从「最小宽/固定宽」改成固定宽 −10px（名称再 −20）
    expect(widthOf('市场')).toBe('50px')
    expect(widthOf('代码')).toBe('70px')
    expect(widthOf('名称')).toBe('60px')
    expect(widthOf('昨收价')).toBe('74px')
    expect(widthOf('现价')).toBe('74px')
    expect(widthOf('涨跌')).toBe('74px')
    expect(widthOf('最高价')).toBe('74px')
    expect(widthOf('最低价')).toBe('74px')
    expect(widthOf('成交量')).toBe('86px')
    expect(widthOf('成交额')).toBe('94px')
    expect(widthOf('换手率')).toBe('74px')
    expect(widthOf('总市值')).toBe('94px')
    // 指标列本轮再 −40（160 → 120）；「Agent 状态」整列删除、图标搬进操作列，
    // 操作列 180 → 220（多一个按钮的宽度 + 间隔）
    expect(widthOf('指标')).toBe('120px')
    expect(widthOf('操作')).toBe('220px')
    expect(headers).not.toContain('Agent 状态')

    // 市场～总市值不再留 minWidth（否则浏览器会按内容撑开，固定宽失效）
    const cols = table.querySelectorAll('colgroup col')
    for (const label of ['市场', '代码', '名称', '昨收价', '现价', '涨跌', '最高价', '最低价', '成交量', '成交额', '换手率', '总市值']) {
      expect((cols[headers.indexOf(label)] as HTMLElement).style.minWidth).toBe('')
    }

    // 指标列前面 20px 间距（表头与单元格共用 paddingLeft，否则对不齐）
    const indicatorHeader = within(table).getAllByRole('columnheader')[headers.indexOf('指标')]
    expect((indicatorHeader as HTMLElement).style.paddingLeft).toBe('20px')
    // 名称列收窄到 60 后左右内边距改成 4px，否则四字名会被截成省略号
    const nameHeader = within(table).getAllByRole('columnheader')[headers.indexOf('名称')]
    expect((nameHeader as HTMLElement).style.paddingLeft).toBe('4px')
    expect((nameHeader as HTMLElement).style.paddingRight).toBe('4px')
  })

  it('belowToolbar 渲染在工具条那一行的下面、表格之前', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable({
      toolbarActions: <button type="button">工具条按钮</button>,
      belowToolbar: <div data-testid="screen-banner">选股结果横幅</div>,
    })

    const banner = await screen.findByTestId('screen-banner')
    const toolbar = screen.getByRole('button', { name: '工具条按钮' })
    const table = screen.getByRole('table')
    // 文档顺序：工具条 → 横幅 → 表格（用户要求横幅在「条件选股」按钮那行的下面）
    expect(toolbar.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('全量只取一次，且不再发外网批量行情/技术面请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const urls = urlsOf()
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/stocks/market-table')
    expect(urls[0]).toContain('board=all')
    expect(urls[0]).toContain(`limit=${MARKET_FETCH_LIMIT}`)
    // 被数据源限流的那两条，全市场列表中必须一条都不发
    expect(urls.filter(url => url.includes('/quotes/batch'))).toHaveLength(0)
    expect(urls.filter(url => url.includes('/klines/summary/batch'))).toHaveLength(0)
  })

  it('板块筛选与搜索都在前端做：换了不发新请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { rerender } = render(
      <StockMarketTable
        board="all"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    // 换板块 → 只剩沪市那只
    rerender(
      <StockMarketTable
        board="sh"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    expect(urlsOf()).toHaveLength(1)
  })

  it('市场列只出 沪/深/北 + 数值按列格式化', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    // 默认按代码升序：000001 → 600519 → 920000
    const [shen, hu, bei] = rows

    expect(within(hu).getByText('沪')).toBeTruthy()
    expect(within(hu).getByText('600519')).toBeTruthy()
    expect(within(hu).getByText('1286.00')).toBeTruthy() // 昨收价
    expect(within(hu).getByText('1290.50')).toBeTruthy() // 现价
    expect(within(hu).getByText('+0.35%')).toBeTruthy()
    expect(within(hu).getByText('1299.00')).toBeTruthy() // 最高价
    expect(within(hu).getByText('1276.02')).toBeTruthy() // 最低价
    expect(within(hu).getByText('1.61万亿')).toBeTruthy() // 总市值

    expect(within(shen).getByText('深')).toBeTruthy()
    expect(within(shen).getByText('-1.61%')).toBeTruthy()
    expect(within(shen).getByText('2249.15亿')).toBeTruthy()

    expect(within(bei).getByText('北')).toBeTruthy()
    // 富列由页面注入
    expect(within(hu).getByText('状态-600519')).toBeTruthy()
    expect(within(hu).getByText('技术指标 · 10-14')).toBeTruthy()
    expect(within(hu).getByText('操作-600519')).toBeTruthy()
  })

  it('代码点击 = 复制「代码 + 名称」，名称点击 = 打开详情弹窗', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const onCopyCode = vi.fn()
    const { onOpenDetail } = renderTable({ onCopyCode })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    // 名称 → 详情弹窗（行为不变）
    await userEvent.click(screen.getByRole('button', { name: '贵州茅台' }))
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onOpenDetail.mock.calls[0][0].code).toBe('600519')

    // 代码 → 复制（不再是详情）
    await userEvent.click(screen.getByRole('button', { name: '600519' }))
    expect(onCopyCode).toHaveBeenCalledTimes(1)
    expect(onCopyCode.mock.calls[0][0].code).toBe('600519')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('名称悬停提示显示**原始名字**（剥掉 *ST/ST 标记）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(
      response([row({ code: '600745', name: '*ST闻泰' }), row({ code: '600079', name: 'ST人福' })]),
    )
    renderTable()

    await waitFor(() => expect(screen.getByText('*ST闻泰')).toBeTruthy())
    expect(screen.getByRole('button', { name: '*ST闻泰' }).getAttribute('title')).toBe('闻泰')
    expect(screen.getByRole('button', { name: 'ST人福' }).getAttribute('title')).toBe('人福')
  })

  it('市场列不给排序；其余列是「降序 → 升序 → 取消」三态循环', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    // 市场列没有排序按钮
    expect(screen.queryByRole('button', { name: '按市场排序' })).toBeNull()
    // 未排序 = 接口给的顺序（后端 ORDER BY code）
    expect(codesInOrder()).toEqual(['000001', '600519', '920000'])

    const sortButton = () => screen.getByRole('button', { name: '按涨跌排序' })
    // 未排序：灰图标 + 「点击降序」
    expect(sortButton().getAttribute('title')).toBe('点击降序')

    // 第一次点击 → 降序（+0.35 → −1.60 → −1.61）
    await userEvent.click(sortButton())
    await waitFor(() => expect(codesInOrder()).toEqual(['600519', '920000', '000001']))
    expect(sortButton().getAttribute('title')).toBe('点击升序')

    // 第二次点击 → 升序
    await userEvent.click(sortButton())
    await waitFor(() => expect(codesInOrder()).toEqual(['000001', '920000', '600519']))
    expect(sortButton().getAttribute('title')).toBe('取消排序')

    // 第三次点击 → 取消排序：回到接口给的原始顺序（后端 ORDER BY code，即代码升序）
    await userEvent.click(sortButton())
    await waitFor(() => expect(codesInOrder()).toEqual(['000001', '600519', '920000']))
    expect(sortButton().getAttribute('title')).toBe('点击降序')
  })

  it('排序作用于全量数据（先排 5000 余行再切片，不是只排当前页）', async () => {
    // 250 行：每页 100 → 3 页；按市值降序后第 1 页应是最大的 100 只
    const many = Array.from({ length: 250 }, (_, index) =>
      row({
        code: String(100000 + index),
        name: `票${index}`,
        total_market_cap: (index + 1) * 1e8,
      }),
    )
    vi.mocked(fetchAPI).mockResolvedValue(response(many))
    renderTable()

    await waitFor(() => expect(screen.getByText('票0')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '按总市值排序' }))

    // 第 1 页第 1 行 = 全局最大（index 249），最后 1 行 = 第 100 大（index 150）
    await waitFor(() => expect(screen.getByText('票249')).toBeTruthy())
    const codes = codesInOrder()
    expect(codes).toHaveLength(100)
    expect(codes[0]).toBe('100249')
    expect(codes[99]).toBe('100150')
  })

  it('三组筛选（状态/涨跌/市值）都在前端做，且不发新请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const filters = { ...EMPTY_MARKET_FILTERS, change: 'down' as const }
    const { rerender } = render(
      <StockMarketTable
        board="all"
        query=""
        filters={filters}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    // 涨跌=下跌 → 只剩 000001 与 920000（茅台是涨的）
    await waitFor(() => expect(screen.queryByText('贵州茅台')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()

    // 市值 < 50 亿 → 只剩北交所那只（10 亿）
    rerender(
      <StockMarketTable
        board="all"
        query=""
        filters={{ ...EMPTY_MARKET_FILTERS, cap: ['lt50'] }}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.queryByText('贵州茅台')).toBeNull())
    expect(screen.getByText('安徽凤凰')).toBeTruthy()

    // 状态筛选走页面注入的 getRowAction（技术面动作）
    rerender(
      <StockMarketTable
        board="all"
        query=""
        filters={{ ...EMPTY_MARKET_FILTERS, indicator: ['avoid'] }}
        existingSymbols={new Set<string>()}
        getRowAction={(r: MarketRow) => (r.tech ? (r.tech.score <= -2 ? 'avoid' : 'buy') : null)}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.queryByText('贵州茅台')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()

    expect(urlsOf()).toHaveLength(1)
  })

  it('搜索框只在上一条分页条里，工具条按钮排在它前面（底下那条没有搜索框）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable({
      toolbarActions: <button type="button">刷新</button>,
      searchSlot: <input aria-label="测试搜索" />,
    })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    // 用户第二轮要求：底部不要搜索框 → 全页只有 1 个
    expect(screen.getAllByLabelText('测试搜索')).toHaveLength(1)
    // 按钮在搜索框**前面**（同一行，两者之间留 50px，见 TablePagination 的 TOOLBAR_GAP_PX）
    const search = screen.getByLabelText('测试搜索')
    const toolbarButton = screen.getByRole('button', { name: '刷新' })
    expect(toolbarButton.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('筛选控件排在搜索框后面（用户要求把市场/状态/涨跌/市值/清空挪到搜索框后）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable({
      toolbarActions: <button type="button">条件选股</button>,
      searchSlot: <input aria-label="测试搜索" />,
      filtersSlot: <div data-testid="filter-bar">筛选条</div>,
    })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const search = screen.getByLabelText('测试搜索')
    const filterBar = screen.getByTestId('filter-bar')
    const screenButton = screen.getByRole('button', { name: '条件选股' })

    // 文档顺序：条件选股 → 搜索框 → 筛选条（三段都在工具条那一行里）
    expect(screenButton.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(search.compareDocumentPosition(filterBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 只有上一条分页条有筛选条（底部那条不该重复渲染）
    expect(screen.getAllByTestId('filter-bar')).toHaveLength(1)
  })

  it('各板块计数从全量数据里数出来并回传（pill 上的数字）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onCounts } = renderTable()

    await waitFor(() => expect(onCounts).toHaveBeenCalled())
    // 北交所那只 board='other'：只计入「全部」
    expect(onCounts.mock.calls[0][0]).toEqual({ all: 3, sh: 1, sz: 1, kcb: 0, cyb: 0, st: 0 })
  })

  it('翻页只切前端切片，不再打接口', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    await userEvent.click(screen.getAllByRole('button', { name: '下一页' })[0])

    expect(urlsOf()).toHaveLength(1)
    expect(screen.getByText('贵州茅台')).toBeTruthy()
  })

  it('分页条上下各一条，且都显示「共 N 条」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(screen.getAllByText('共 3 条')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '上一页' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '下一页' })).toHaveLength(2)
    // 每页条数下拉（默认 100 条/页）
    expect(screen.getAllByText('100 条/页').length).toBeGreaterThan(0)
  })

  it('表头点击排序：指标列按库里分数，无分的新股恒排最后', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(codesInOrder()).toEqual(['000001', '600519', '920000'])

    // 第一次点「指标」→ 分数降序（6 在前，-3 在后，无分的最后）
    await userEvent.click(screen.getByRole('button', { name: '按指标排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['600519', '000001', '920000']))

    // 再点一次 → 升序，但「无分」仍然在最后（不是跑到最前）
    await userEvent.click(screen.getByRole('button', { name: '按指标排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['000001', '600519', '920000']))

    // 数值列：涨跌降序
    await userEvent.click(screen.getByRole('button', { name: '按涨跌排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['600519', '920000', '000001']))
  })

  it('搜索走 Everything 语法，匹配「代码 + 名称」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())

    const view = (query: string) => (
      <StockMarketTable
        board="all"
        query={query}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const { rerender } = render(view(''))
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    // OR：平安 或 茅台 → 两只；安徽凤凰被滤掉
    rerender(view('平安|茅台'))
    await waitFor(() => expect(screen.queryByText('安徽凤凰')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    // 空格 = AND，代码 + 名称合并匹配：600519 且 茅台
    rerender(view('600519 茅台'))
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    // AND 的两半分别落在代码和名称上也能命中
    rerender(view('000001 平安'))
    await waitFor(() => expect(screen.queryByText('贵州茅台')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()

    // NOT：去掉含「银行」的
    rerender(view('!银行'))
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()
  })

  it('状态列口径：库里无 tech_*（新股）时不显示徽章而是「数据不足」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response([row(), row({ code: '688825', name: '长鑫科技', tech: null })]))
    render(
      <StockMarketTable
        board="all"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={r => (r.tech ? <span>badge-{r.tech.score}</span> : <span>数据不足</span>)}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )

    await waitFor(() => expect(screen.getByText('badge-6')).toBeTruthy())
    expect(screen.getByText('数据不足')).toBeTruthy()
  })

  it('reloadToken 变化时重新取全量，筛选本身不取', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const view = (reloadToken: number) => (
      <StockMarketTable
        board="all"
        query=""
        reloadToken={reloadToken}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const { rerender } = render(view(0))
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(urlsOf()).toHaveLength(1)

    rerender(view(0))
    expect(urlsOf()).toHaveLength(1)

    rerender(view(1))
    await waitFor(() => expect(urlsOf()).toHaveLength(2))
    expect(urlsOf().every(url => url.includes('/stocks/market-table'))).toBe(true)
  })

  it('已关注的行给出 X（取消关注），未关注给出 +（关注）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onAdd, onRemove } = renderTable({ existingSymbols: new Set(['000001']) })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    await userEvent.click(screen.getByText('操作-600519'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByText('操作-000001'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  /* ------------------------------------------------------------------
   * 条件选股（需求规格 §12.5 T1–T3）：表格的 sourceRows 外部数据源
   * ------------------------------------------------------------------ */

  it('T1 传入 sourceRows 时显示选股结果，且不再额外请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const picked = [row({ code: '600036', symbol: 'sh600036', name: '招商银行' })]
    const view = (sourceRows: MarketRow[] | null) => (
      <StockMarketTable
        board="all"
        query=""
        sourceRows={sourceRows}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const { rerender } = render(view(picked))

    // 表格仍然会取一次全量（退出选股时要用这份缓存），但选股结果不触发任何请求
    await waitFor(() => expect(screen.getByText('招商银行')).toBeTruthy())
    expect(screen.queryByText('贵州茅台')).toBeNull()
    expect(urlsOf()).toHaveLength(1)
    expect(urlsOf()[0]).toContain('/stocks/market-table')

    rerender(view([row({ code: '000002', symbol: 'sz000002', name: '万科A' })]))
    await waitFor(() => expect(screen.getByText('万科A')).toBeTruthy())
    expect(screen.queryByText('招商银行')).toBeNull()
    expect(urlsOf()).toHaveLength(1)
  })

  it('T2 sourceRows=[] 时显示选股专用空态文案', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable({ sourceRows: [], emptyTextOverride: '没有股票满足当前条件' })

    await waitFor(() => expect(screen.getByText('没有股票满足当前条件')).toBeTruthy())
    expect(screen.queryByText('暂无数据')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('T3 sourceRows 变回 null 后恢复全量数据，且不重新请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const view = (sourceRows: MarketRow[] | null) => (
      <StockMarketTable
        board="all"
        query=""
        sourceRows={sourceRows}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const picked = [row({ code: '600036', symbol: 'sh600036', name: '招商银行' })]
    const { rerender } = render(view(picked))
    await waitFor(() => expect(screen.getByText('招商银行')).toBeTruthy())

    rerender(view(null))
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(screen.getByText('平安银行')).toBeTruthy()
    expect(screen.queryByText('招商银行')).toBeNull()
    expect(urlsOf()).toHaveLength(1)
  })

  it('选股结果的板块计数按结果集算，退出后回到全量口径', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const onCounts = vi.fn()
    const view = (sourceRows: MarketRow[] | null) => (
      <StockMarketTable
        board="all"
        query=""
        sourceRows={sourceRows}
        existingSymbols={new Set<string>()}
        onCounts={onCounts}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderIndicator={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const { rerender } = render(view([row({ code: '600036', symbol: 'sh600036', name: '招商银行' })]))
    await waitFor(() =>
      expect(onCounts).toHaveBeenLastCalledWith({ all: 1, sh: 1, sz: 0, kcb: 0, cyb: 0, st: 0 }),
    )

    rerender(view(null))
    await waitFor(() =>
      expect(onCounts).toHaveBeenLastCalledWith({ all: 3, sh: 1, sz: 1, kcb: 0, cyb: 0, st: 0 }),
    )
    expect(urlsOf()).toHaveLength(1)
  })
})
