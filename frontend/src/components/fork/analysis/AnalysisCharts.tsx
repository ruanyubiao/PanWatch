/**
 * 统计图（纯 SVG，不引任何图表库）。
 *
 * 为什么自绘：这个 fork 里没有 recharts/echarts/d3，加一个依赖就要动
 * ``package.json`` 与 lockfile；而这里要的四类图（成对柱子、折线、热力格、
 * 直方图）用 ``<rect>``/``<polyline>`` 就够，几百行、无运行时成本。
 *
 * 每一张图都带 ``<title>``（悬停能看到精确数值）与 ``data-fork-chart`` 锚点，
 * 布局类断言可以按锚点量，不必靠截图。
 */
import type { ReactNode } from 'react'

export const CHART_TEXTS_ZH = {
  signal: '条件组',
  control: '对照组随机',
  empty: '暂无数据',
  horizonUnit: (n: number) => `${n} 日`,
}

const SIGNAL_COLOR = '#2b3eee'
const CONTROL_COLOR = '#94a3b8'
const POSITIVE = '#16a34a'
const NEGATIVE = '#dc2626'
const NEUTRAL = '#94a3b8'

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

/** 超额胜率的配色：|超额| < 2 个百分点按「与随机买入没区别」涂灰。 */
export function excessColor(value: number | null | undefined): string {
  if (value === null || value === undefined) return NEUTRAL
  if (value >= 2) return POSITIVE
  if (value <= -2) return NEGATIVE
  return NEUTRAL
}

export interface BarPairItem {
  label: string
  signal: number | null
  control: number | null
  excess: number | null
}

/** 六周期胜率：条件组 vs 对照组（同一张图里对照才有意义）。 */
export function BarPairChart({
  items,
  height = 230,
  width = 620,
  unit = '%',
}: {
  items: BarPairItem[]
  height?: number
  width?: number
  /** 顶部留白给图例 */
  unit?: string
}) {
  const margin = { left: 38, right: 12, top: 26, bottom: 28 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  const values = items.flatMap(item => [item.signal ?? 0, item.control ?? 0])
  const maxValue = Math.max(10, ...values)
  const top = Math.ceil(maxValue / 10) * 10 + 5
  const slot = plotW / Math.max(1, items.length)
  const barW = Math.min(26, slot * 0.3)

  if (items.length === 0) {
    return <EmptyChart height={height} width={width} />
  }

  return (
    <svg
      data-fork-chart="bar-pair"
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
    >
      {/* 图例 */}
      <g transform={`translate(${margin.left}, 12)`}>
        <rect x={0} y={-8} width={9} height={9} fill={SIGNAL_COLOR} rx={1} />
        <text x={13} y={1} fill="currentColor" fillOpacity={0.65} fontSize={10}>
          {CHART_TEXTS_ZH.signal}
        </text>
        <rect x={78} y={-8} width={9} height={9} fill={CONTROL_COLOR} rx={1} />
        <text x={91} y={1} fill="currentColor" fillOpacity={0.65} fontSize={10}>
          {CHART_TEXTS_ZH.control}
        </text>
      </g>

      {/* 纵轴网格（0 / 25 / 50 / 75 / 100 的相对刻度） */}
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const y = margin.top + plotH - ratio * plotH
        return (
          <g key={ratio}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.12}
              strokeDasharray={ratio === 0.5 ? '4 3' : undefined}
            />
            <text x={margin.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.65}>
              {Math.round(top * ratio)}
            </text>
          </g>
        )
      })}

      {items.map((item, index) => {
        const centre = margin.left + slot * (index + 0.5)
        const signalValue = item.signal ?? 0
        const controlValue = item.control ?? 0
        const signalH = (signalValue / top) * plotH
        const controlH = (controlValue / top) * plotH
        return (
          <g key={item.label}>
            <rect
              x={centre - barW - 2}
              y={margin.top + plotH - signalH}
              width={barW}
              height={Math.max(0, signalH)}
              fill={SIGNAL_COLOR}
              rx={1}
            >
              <title>{`${item.label} ${CHART_TEXTS_ZH.signal} ${fmt(item.signal)}${unit}`}</title>
            </rect>
            <rect
              x={centre + 2}
              y={margin.top + plotH - controlH}
              width={barW}
              height={Math.max(0, controlH)}
              fill={CONTROL_COLOR}
              rx={1}
            >
              <title>{`${item.label} ${CHART_TEXTS_ZH.control} ${fmt(item.control)}${unit}`}</title>
            </rect>
            <text
              x={centre}
              y={margin.top + plotH - Math.max(signalH, controlH) - 14}
              textAnchor="middle"
              fontSize={9}
              fill={excessColor(item.excess)}
              fontWeight={600}
            >
              {item.excess === null ? '' : `${item.excess > 0 ? '+' : ''}${fmt(item.excess)}pp`}
            </text>
            <text
              x={centre}
              y={height - margin.bottom + 14}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor" fillOpacity={0.65}
            >
              {item.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export interface LineSeries {
  name: string
  color?: string
  points: { x: string; y: number | null }[]
}

/** 折线（按年看稳定性）：条件组 vs 对照组两条线。 */
export function LineChart({
  series,
  height = 210,
  width = 620,
  minValue = 0,
  maxValue = 100,
  unit = '%',
}: {
  series: LineSeries[]
  height?: number
  width?: number
  minValue?: number
  maxValue?: number
  unit?: string
}) {
  const margin = { left: 38, right: 12, top: 22, bottom: 26 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  const labels = series[0]?.points.map(point => point.x) ?? []
  if (labels.length === 0) return <EmptyChart height={height} width={width} />
  const slot = labels.length > 1 ? plotW / (labels.length - 1) : 0
  const range = Math.max(1, maxValue - minValue)
  const yOf = (value: number) => margin.top + plotH - ((value - minValue) / range) * plotH

  return (
    <svg data-fork-chart="line" viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const value = minValue + range * ratio
        const y = yOf(value)
        return (
          <g key={ratio}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.12}
            />
            <text x={margin.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.65}>
              {Math.round(value)}
            </text>
          </g>
        )
      })}
      {labels.map((label, index) => (
        <text
          key={label}
          x={margin.left + slot * index}
          y={height - margin.bottom + 14}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor" fillOpacity={0.65}
        >
          {label}
        </text>
      ))}
      {series.map(line => {
        const points = line.points
          .map((point, index) =>
            point.y === null ? null : `${margin.left + slot * index},${yOf(Math.min(maxValue, Math.max(minValue, point.y)))}`,
          )
          .filter((value): value is string => value !== null)
        return (
          <g key={line.name}>
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke={line.color ?? SIGNAL_COLOR}
              strokeWidth={1.8}
              strokeLinejoin="round"
            />
            {line.points.map((point, index) =>
              point.y === null ? null : (
                <circle
                  key={`${line.name}-${point.x}`}
                  cx={margin.left + slot * index}
                  cy={yOf(Math.min(maxValue, Math.max(minValue, point.y)))}
                  r={2.2}
                  fill={line.color ?? SIGNAL_COLOR}
                >
                  <title>{`${line.name} ${point.x} ${fmt(point.y)}${unit}`}</title>
                </circle>
              ),
            )}
            <g transform={`translate(${margin.left + (series.indexOf(line) * 110)}, 12)`}>
              <rect x={0} y={-8} width={9} height={9} fill={line.color ?? SIGNAL_COLOR} rx={1} />
              <text x={13} y={1} fontSize={10} fill="currentColor" fillOpacity={0.65}>
                {line.name}
              </text>
            </g>
          </g>
        )
      })}
    </svg>
  )
}

export interface HeatmapRow {
  label: string
  values: (number | null)[]
}

/** 热力格：市场/年度 × 持有周期（值 = 超额胜率，百分点）。 */
export function Heatmap({
  rows,
  columns,
  width = 620,
  cellHeight = 26,
}: {
  rows: HeatmapRow[]
  columns: string[]
  width?: number
  cellHeight?: number
}) {
  const labelWidth = 76
  const cellWidth = (width - labelWidth) / Math.max(1, columns.length)
  const height = 24 + rows.length * cellHeight
  if (rows.length === 0) return <EmptyChart height={160} width={width} />

  const shade = (value: number | null) => {
    if (value === null) return { fill: 'transparent', text: '#94a3b8' }
    const clamped = Math.max(-10, Math.min(10, value))
    if (clamped > 0) {
      const alpha = Math.min(0.85, Math.abs(clamped) / 10)
      return { fill: `rgba(22, 163, 74, ${alpha})`, text: alpha > 0.45 ? '#ffffff' : '#14532d' }
    }
    if (clamped < 0) {
      const alpha = Math.min(0.85, Math.abs(clamped) / 10)
      return { fill: `rgba(220, 38, 38, ${alpha})`, text: alpha > 0.45 ? '#ffffff' : '#7f1d1d' }
    }
    return { fill: 'rgba(148,163,184,0.25)', text: '#334155' }
  }

  return (
    <svg data-fork-chart="heatmap" viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      {columns.map((column, index) => (
        <text
          key={column}
          x={labelWidth + cellWidth * (index + 0.5)}
          y={14}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor" fillOpacity={0.65}
        >
          {column}
        </text>
      ))}
      {rows.map((row, rowIndex) => (
        <g key={row.label} transform={`translate(0, ${20 + rowIndex * cellHeight})`}>
          <text x={labelWidth - 6} y={cellHeight / 2 + 3} textAnchor="end" fontSize={10} fill="currentColor">
            {row.label}
          </text>
          {row.values.map((value, index) => {
            const style = shade(value)
            return (
              <g key={`${row.label}-${index}`}>
                <rect
                  x={labelWidth + cellWidth * index + 1}
                  y={1}
                  width={cellWidth - 2}
                  height={cellHeight - 3}
                  fill={style.fill}
                  rx={2}
                >
                  <title>{`${row.label} ${columns[index]} ${value === null ? '—' : `${fmt(value)}pp`}`}</title>
                </rect>
                <text
                  x={labelWidth + cellWidth * (index + 0.5)}
                  y={cellHeight / 2 + 2}
                  textAnchor="middle"
                  fontSize={9}
                  fill={style.text}
                >
                  {value === null ? '—' : fmt(value)}
                </text>
              </g>
            )
          })}
        </g>
      ))}
    </svg>
  )
}

/** 涨幅分布（条件组）：看右尾够不够长、有没有明显左偏。 */
export function HistogramChart({
  edges,
  counts,
  height = 150,
  width = 300,
}: {
  edges: number[]
  counts: number[]
  height?: number
  width?: number
}) {
  const margin = { left: 26, right: 8, top: 12, bottom: 20 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  const total = counts.reduce((sum, value) => sum + value, 0)
  if (total === 0) return <EmptyChart height={height} width={width} />
  const maxCount = Math.max(...counts)
  const barW = plotW / counts.length
  const zeroIndex = edges.findIndex(edge => edge === 0)

  return (
    <svg data-fork-chart="histogram" viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      {counts.map((count, index) => {
        const barH = (count / maxCount) * plotH
        const negative = edges[index] < 0
        return (
          <rect
            key={edges[index]}
            x={margin.left + barW * index + 0.5}
            y={margin.top + plotH - barH}
            width={Math.max(1, barW - 1)}
            height={Math.max(0, barH)}
            fill={negative ? NEGATIVE : POSITIVE}
            fillOpacity={0.75}
            rx={1}
          >
            <title>{`${edges[index]}% ~ ${edges[index + 1]}%：${count} 条`}</title>
          </rect>
        )
      })}
      {zeroIndex >= 0 && (
        <line
          x1={margin.left + barW * zeroIndex}
          x2={margin.left + barW * zeroIndex}
          y1={margin.top}
          y2={margin.top + plotH}
          stroke="currentColor"
          strokeOpacity={0.4}
          strokeDasharray="3 2"
        />
      )}
      <text x={margin.left} y={height - 6} fontSize={9} fill="currentColor" fillOpacity={0.65}>
        {`${edges[0]}%`}
      </text>
      <text x={width - margin.right} y={height - 6} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.65}>
        {`${edges[edges.length - 1]}%`}
      </text>
    </svg>
  )
}

/** 每日命中数（看条件是不是近年变稀疏）。 */
export function DensityChart({
  points,
  height = 120,
  width = 620,
}: {
  points: { d0: string; hits: number }[]
  height?: number
  width?: number
}) {
  const margin = { left: 30, right: 10, top: 10, bottom: 18 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  if (points.length === 0) return <EmptyChart height={height} width={width} />
  const maxHits = Math.max(1, ...points.map(point => point.hits))
  const step = points.length > 1 ? plotW / (points.length - 1) : plotW
  const path = points
    .map((point, index) => `${margin.left + step * index},${margin.top + plotH - (point.hits / maxHits) * plotH}`)
    .join(' ')

  return (
    <svg data-fork-chart="density" viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      <polyline points={path} fill="none" stroke={SIGNAL_COLOR} strokeWidth={1.4} />
      <text x={margin.left - 6} y={margin.top + 6} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.65}>
        {maxHits}
      </text>
      <text x={margin.left} y={height - 5} fontSize={9} fill="currentColor" fillOpacity={0.65}>
        {points[0]?.d0}
      </text>
      <text x={width - margin.right} y={height - 5} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.65}>
        {points[points.length - 1]?.d0}
      </text>
    </svg>
  )
}

function EmptyChart({ height, width }: { height: number; width: number }): ReactNode {
  return (
    <div
      data-fork-chart="empty"
      className="flex items-center justify-center text-[11px] text-muted-foreground"
      style={{ height: Math.min(height, 140), minWidth: Math.min(width, 240) }}
    >
      {CHART_TEXTS_ZH.empty}
    </div>
  )
}
