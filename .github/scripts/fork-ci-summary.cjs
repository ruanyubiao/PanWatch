/**
 * fork 专用：把 CI 实测结果写进 PR 描述。
 *
 * 为什么由 CI 做这件事：写这份代码的工作站只有对 GitHub 的 SSH 推送权限，没有任何
 * API 凭据（没有 gh CLI、没有 PAT），所以「把结果贴到 PR 描述」只能由 workflow 自己完成。
 *
 * 消费者是 fork-tests 的 pr-summary job（pull_request 事件，每次同步刷新一次）。
 * 描述为空时（新建 PR 由人工在网页上点，GitHub 只会填提交列表）先放上模板正文，再接结果区块。
 *
 * 区块用 HTML 注释包起来：重复运行是替换，不会重复追加，也不会动人工写在区块外的内容。
 *
 * 注意：CI 不能建 PR —— 仓库设置里「Allow GitHub Actions to create and approve pull
 * requests」默认关闭，实测报 `GitHub Actions is not permitted to create or approve pull
 * requests`。这一项只能由仓库所有者在 Settings → Actions → General 打开；打开后若要自动化建 PR，
 * 恢复 open-pr job（在 push 事件上用 GITHUB_TOKEN 调 pulls.create）即可。
 */

const START = '<!-- fork-ci-summary:start -->'
const END = '<!-- fork-ci-summary:end -->'

const PR_BODY = `本 PR 是 fork 内部的分支评审载体：\`analysis-*\` → \`main\`，不向上游提交。

## 这条分支是什么

- 基线 = \`main\`（== upstream/main），全部定制线性压在最后：81 个文件、+14755/−15。
  其中 65 个是新增文件；16 个改动里对上游源文件只动必要几处（路由注册一行、板块判定把 ST 判定包在纯前缀规则外面、
  表格组件加三个可选 prop、底部错误码表补 5 项）。
- 已落地：分析页（全市场表格读自建 MySQL）、条件选股、关注/全部两视图共用一套卡片与工具条、
  未关注股票也能跑深度分析、\`deploy/\` 源码部署工具链。

## 本轮新增：条件选股

- 后端：\`src/modules/market/fork_screen/\`（models / conditions / evaluator / repository）+ \`POST /api/stocks/screen\`（挂在 \`/api/stocks\` 前缀、登录保护）。
- 前端：\`lib/screen-rule.ts\`、\`lib/screen-api.ts\`、\`components/fork/Screen*.tsx\` 六个组件；
  表格新增 \`sourceRows\` 替换数据源，退出选股恢复全量缓存、不重新请求。
- 口径说明：读 \`stock_daily\` 而不是 \`stock_daily_recent\` —— 云端近期表只保留 59 个交易日（2026-07-21 起），
  撑不住 MA250 / 250 日窗口；两表列与索引完全相同，\`repository._BARS_TABLE\` 一行可切回。
- 实测（云端库 5,027 只候选）：默认 K=60 端到端约 2.5s（150ms + 4ms + 2.1s）；最坏 K=251 为 8.3s、进程峰值 300MB。

## CI

由本分支自带的 \`.github/workflows/fork-tests.yml\` 跑：后端全量 pytest、前端 vitest + check:ui + check:market-colors + build，
另外上游的 frontend i18n 与 Timezone contracts 也会在 PR 上跑。结果由 CI 自己写在本节下方 —— 本机没有 GitHub 写权限凭据。

## 部署状态

未部署。云端 \`/opt/PanWatch\` 仍跑上一个提交；发版需要 \`deploy/10-publish.sh\` + 服务器上 \`deploy/15-restart.sh\`。
`

const resultMark = (result) => (
  result === 'success' ? '✅ success' : result === 'failure' ? '❌ failure' : `⚠️ ${result || 'unknown'}`
)

const tableCell = (value) => {
  const text = (value || '(no output)').toString().replace(/\|/g, '\\|').trim().slice(0, 220)
  return text || '(no output)'
}

const summarySection = (env) => [
  START,
  '### CI 结果（fork tests 自动写入，请勿手改本节）',
  '',
  `- 提交：\`${String(env.HEAD_SHA || '').slice(0, 8)}\`（base \`${String(env.BASE_SHA || '').slice(0, 8)}\`）`,
  `- run：[${String(env.RUN_URL || '').split('/').pop()}](${env.RUN_URL})`,
  '',
  '| job | 结果 | 实测摘要 |',
  '| --- | --- | --- |',
  `| backend pytest | ${resultMark(env.BACKEND_RESULT)} | ${tableCell(env.BACKEND_PYTEST)} |`,
  `| backend marketdata | ${resultMark(env.BACKEND_RESULT)} | ${tableCell(env.BACKEND_MARKETDATA)} |`,
  `| frontend vitest | ${resultMark(env.FRONTEND_RESULT)} | ${tableCell(env.FRONTEND_VITEST)} |`,
  `| frontend build | ${resultMark(env.FRONTEND_RESULT)} | ${tableCell(env.FRONTEND_BUILD)} |`,
  END,
].join('\n')

const withSection = (body, env) => {
  const section = summarySection(env)
  const existing = body || ''
  if (existing.includes(START)) {
    return existing.replace(new RegExp(`${START}[\\s\\S]*?${END}`), section)
  }
  const trimmed = existing.trim()
  return trimmed ? `${trimmed}\n\n${section}` : section
}

/** 把结果区块写进指定 PR 的描述（区块外的内容原样保留；描述为空时先放模板正文）。返回更新后的 PR。 */
const upsertSummaryForNumber = async (github, core, { owner, repo, number, env }) => {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number })
  const body = pr.body || ''
  const base = body.trim() ? body : PR_BODY
  const next = withSection(base, env)
  if (next === body) {
    core.info(`PR #${number} description already up to date`)
    return pr
  }
  const { data: updated } = await github.rest.pulls.update({ owner, repo, pull_number: number, body: next })
  core.info(`updated description of PR #${number}`)
  return updated
}

module.exports = {
  START,
  END,
  PR_BODY,
  summarySection,
  withSection,
  upsertSummaryForNumber,
}
