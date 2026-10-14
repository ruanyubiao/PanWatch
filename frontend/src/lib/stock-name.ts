/**
 * fork 专用：从库里的股票名还原**原始名字**。
 *
 * 数据管道里 ``stock_info.name`` 与 ``display_name`` 目前是同一个值，都带
 * ``*ST`` / ``S*ST`` / ``SST`` / ``ST`` 这类风险警示前缀（实测样本全表 0 处差异），
 * 所以「原始名字」只能在这里剥出来 —— 表格「名称」列悬停时显示的就是剥离后的名字，
 * 单元格里仍然显示库里那个带标记的名字（警告标记不能藏起来）。
 *
 * 注意只剥**开头**的标记：``*ST康佳A`` → ``康佳A``、``SST前锋`` → ``前锋``；
 * 名字本身就是 ``ST``（长度正好等于标记）时不剥，避免剥成空串。
 */

/** 风险警示前缀（长标记优先，否则 `*ST` 会被 `ST` 抢先匹配掉一半）。 */
const WARNING_PREFIX = /^(\*ST|S\*ST|SST|ST)(?=.)/

export function originalStockName(name?: string | null): string {
  const raw = String(name ?? '')
  const match = raw.match(WARNING_PREFIX)
  return match ? raw.slice(match[1].length) : raw
}
