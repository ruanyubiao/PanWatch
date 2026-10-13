/**
 * fork：股票方块卡片网格 / 页面宽度常量
 *
 * 「关注」与「全部」两个列表必须共用同一份网格类，否则列宽列数会不一样
 * （用户反馈过两次 UI 不一致）。两个列表的工具栏同理，共用
 * components/fork/StockListToolbar.tsx —— 高度固定，切换范围时不抖动。
 *
 * 列数：1 → 2 → 3 → 4，超宽屏继续加列，让单卡宽度稳定在 ~460px。
 * 之前封顶 2400px 且最多 5 列，用户指出「内容宽度和导航条宽度不一致」
 * （导航条是全宽的），所以现在不封顶、改用加列来控制单卡宽度：
 *   3828px 屏 → 8 列 × 约 462px（用户认可的密度）。
 * 用 `min-[Npx]:` 任意变体而不是改 tailwind.config.js —— 那是上游文件，不改。
 */
export const STOCK_CARD_GRID_CLASS =
  'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-[1900px]:grid-cols-5 min-[2500px]:grid-cols-6 min-[3100px]:grid-cols-7 min-[3700px]:grid-cols-8'

/**
 * fork：页面内容宽度。
 *
 * 必须是 w-full：外层 <main> 已经和导航条共用同一套 px-4/md:px-6 内边距，
 * 页面自己再加 max-w 就会比导航条窄（用户截图反馈过）。
 * 超宽屏下靠 STOCK_CARD_GRID_CLASS 加列来保持卡片宽度，而不是靠限制容器。
 */
export const FORK_PAGE_WIDTH_CLASS = 'w-full'

/** fork：两个列表共用的分页尺寸（用户要求默认最多 100 个） */
export const STOCK_PAGE_SIZE = 100
