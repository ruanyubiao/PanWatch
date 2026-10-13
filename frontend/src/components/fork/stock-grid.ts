/**
 * fork：股票方块卡片网格 / 页面宽度常量
 *
 * 「关注」与「全部」两个列表必须共用同一份网格类，否则列宽列数会不一样
 * （用户反馈过两次 UI 不一致）。
 *
 * 列数：1 → 2 → 3 → 4，≥1900px 时 5 列。
 * 用户屏宽 3828px，3 列时单卡被拉到 1100px 宽，5 列约 460px，接近上游设计密度。
 * 用 `min-[1900px]:` 任意变体而不是改 tailwind.config.js —— 那是上游文件，不改。
 */
export const STOCK_CARD_GRID_CLASS =
  'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-[1900px]:grid-cols-5 gap-3'

/**
 * fork：分析页内容最大宽度。
 * 超宽屏下不加限制，卡片会被拉得极宽且行内留白巨大；居中并封顶后版面稳定。
 */
export const FORK_PAGE_MAX_WIDTH_CLASS = 'mx-auto w-full max-w-[2400px]'
