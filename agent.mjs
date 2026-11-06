/**
 * Always-on watcher for an earning agent: runs on a daily GitHub Actions schedule (GitHub's
 * servers, alive when the home box is off). Dependency-free: Node built-ins only (global fetch,
 * node:fs). Each run:
 *   1. reads the balances of the receive-only wallets in EVM_WALLET (USDC on Base) and SOL_WALLET
 *      (USDC and native SOL on Solana)
 *   2. scans Superteam's agent listings for open bounties, flagging ones new since the last run
 *   3. checks other places work or money could come from: OpenTask's payment router (public, no
 *      key), the dealwork.ai bids and contracts, the toku.agency wallet and unread notifications,
 *      and PR_AUTHOR's PRs to the PR_ORG org (a new merge means an invoice is due)
 *   4. writes status.md, appends history.jsonl and updates seen-listings.json; the workflow
 *      commits them
 *   5. on a real event (a wallet or toku balance rises, a dealwork bid is accepted, a tracked PR
 *      merges) writes NOTIFY.txt, which the workflow turns into a failed run so GitHub's
 *      failed-run email is the alert, once per event
 * The token-intel service probes below are switched off (SERVICE_RETIRED): that service is retired.
 *
 * Settings (repo → Settings → Secrets and variables → Actions → Variables), all optional, each
 * check skipped without its own: EVM_WALLET, SOL_WALLET, PR_AUTHOR and PR_ORG, DEALWORK_AGENT_ID.
 * Nothing personal is written into this file, so a copy watches only what its owner sets.
 * Secrets (same page, Secrets tab), all optional, each check skipped without its key:
 * SUPERTEAM_API_KEY (Superteam scan), DEALWORK_API_KEY (dealwork.ai), TOKU_API_KEY (toku.agency).
 * GITHUB_TOKEN is supplied by Actions; it only authenticates the PR search.
 *
 * The saved state (history.jsonl, seen-listings.json) is only used in the repository that
 * state-repo.json names; a template copy or a fork starts fresh instead (see STATE_REPO below).
 *
 * No private keys live here and nothing is ever spent or signed; that stays offline. Apart from
 * the files above, the only thing it changes is dealwork's "still alive" heartbeat for the agent
 * (sent only when DEALWORK_API_KEY and DEALWORK_AGENT_ID are set). Everything else is a read.
 */
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'

// Settings come from repository variables, which the workflow passes in as environment variables
// (an unset one arrives empty). A check whose setting is missing or doesn't look right is skipped,
// and status.md and the run log name the variable to add or fix.
const SETTINGS = {
  EVM_WALLET: /^0x[0-9a-fA-F]{40}$/, // Base wallet: its USDC balance is read
  SOL_WALLET: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, // Solana wallet: its USDC and native SOL balances are read
  PR_AUTHOR: /^[A-Za-z0-9-]{1,39}$/, // GitHub user whose pull requests are tracked...
  PR_ORG: /^[A-Za-z0-9-]{1,39}$/, // ...to this GitHub organization
  DEALWORK_AGENT_ID: /^[A-Za-z0-9-]{1,64}$/, // dealwork.ai agent the heartbeat is sent for
}
const cfg = {}, unset = [], wrong = []
for (const [name, shape] of Object.entries(SETTINGS)) {
  const value = (process.env[name] || '').trim()
  if (!value) unset.push(name)
  else if (!shape.test(value)) wrong.push(name)
  else cfg[name] = value
}
// Why a check is skipped, for status.md and history.jsonl ('' when its settings are usable).
const skipWhy = (...names) => names.filter((n) => !cfg[n])
  .map((n) => (unset.includes(n) ? `no ${n} variable` : `${n} variable doesn't look right`)).join(', ')

const EVM_WALLET = cfg.EVM_WALLET // Base USDC receive-only
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const now = new Date().toISOString()

async function baseUsdc() {
  try {
    const r = await fetch('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: BASE_USDC, data: '0x70a08231000000000000000000000000' + EVM_WALLET.slice(2) }, 'latest'],
      }),
    })
    const j = await r.json()
    return Number(BigInt(j.result || '0x0')) / 1e6
  } catch (e) { return `err:${e.message}` }
}

async function superteamLive() {
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: 'no SUPERTEAM_API_KEY secret' }
  try {
    const r = await fetch('https://superteam.fun/api/agents/listings/live?take=50', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const items = Array.isArray(d) ? d : d.result || []
    const open = items.filter((l) => (l.deadline || '9999') > now)
      // agentAccess is the competition signal: AGENT_ONLY listings are hidden from human feeds, so
      // they are the highest-odds money (past AGENT_ONLY rounds paid 3000–5000). Surface it + reward
      // so a low-competition high-value drop is obvious the moment it lands — no scorer needed at this
      // volume, just the two fields that decide whether a new listing is worth dropping everything for.
      .map((l) => ({ slug: l.slug, type: l.type, reward: l.rewardAmount, token: l.token, access: l.agentAccess, deadline: (l.deadline || '').slice(0, 10) }))
      .sort((a, b) => (b.access === 'AGENT_ONLY' ? 1 : 0) - (a.access === 'AGENT_ONLY' ? 1 : 0) || (b.reward || 0) - (a.reward || 0))
    return { total: items.length, open }
  } catch (e) { return { error: e.message } }
}

const SERVICE = 'https://token-intel-x402.echolonius.deno.net'
async function serviceHealth() {
  try {
    const r = await fetch(`${SERVICE}/healthz`, { signal: AbortSignal.timeout(10000) })
    return r.ok ? 'live' : `down (HTTP ${r.status})`
  } catch (e) { return `unreachable: ${e.message}` }
}

// Verify the actual PAID route, not just /healthz: an unpaid GET must return 402 with a payment
// challenge. This is the money path — if it 404s/500s we are silently losing every sale, which a
// liveness ping on the free route would never catch. The unpaid probe costs nothing (no settlement).
async function paidRouteHealth() {
  try {
    const r = await fetch(`${SERVICE}/api/token-intel?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`, { signal: AbortSignal.timeout(10000) })
    if (r.status === 402 && r.headers.get('payment-required')) return 'gate-ok (402 challenge served)'
    return `BROKEN (HTTP ${r.status}) — sales path down`
  } catch (e) { return `unreachable: ${e.message}` }
}

// The /demo route runs the FULL intel pipeline (Jupiter + DexScreener fusion) for free — probing it
// catches silent upstream API drift that the 402 gate probe can't see (the gate never runs intel).
async function intelPipelineHealth() {
  try {
    const r = await fetch(`${SERVICE}/api/token-intel/demo`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return `demo BROKEN (HTTP ${r.status}) — intel pipeline down`
    const d = await r.json()
    if (d?.safety?.score == null) return 'demo responds but intel shape wrong — pipeline degraded'
    // MCP surface (added 2026-07-05): stateless tools/list must return both tools.
    let mcp = 'mcp-down'
    try {
      const m = await fetch(`${SERVICE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(10000) })
      const md = await m.json()
      const names = (md?.result?.tools ?? []).map((x) => x.name)
      mcp = names.includes('token_intel') && names.includes('token_intel_demo') ? 'mcp-ok' : `mcp DEGRADED (tools: ${names.join(',') || 'none'})`
    } catch { /* keep mcp-down */ }
    return `pipeline-ok (demo score ${d.safety.score}, ${1 + (d.dexScreener ? 1 : 0) + (d.rugCheck ? 1 : 0)} sources, ${mcp})`
  } catch (e) { return `demo unreachable: ${e.message}` }
}

// Re-probe OpenTask each run: memory recorded its payment router as "unconfigured" (a dead rail). It
// exposes a machine-readable status per method — when any flips to "available", the rail is LIVE and
// we can act (and it lists x402-v2, which our existing service already speaks). This is a genuine net
// beyond Superteam: a second earning source we catch the instant it revives, without any signup.
async function openTaskRail() {
  try {
    const r = await fetch('https://opentask.ai/api/payment-methods', { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { state: `HTTP ${r.status}` }
    const d = await r.json()
    const methods = Array.isArray(d.methods) ? d.methods : []
    const live = methods.filter((m) => m.status === 'available')
    return { state: live.length ? 'AVAILABLE' : 'unconfigured', live: live.map((m) => m.protocol) }
  } catch (e) { return { state: `err:${e.message}` } }
}

// dealwork.ai rail (registered 2026-07-05, agent echo-fable, autonomous onboard — the only other
// zero-signup work marketplace found in the 07-05 sweep). Three duties per run: (1) heartbeat so
// the platform shows us alive (buyers can filter dead agents), (2) watch our bids for acceptance,
// (3) watch contracts — an escrow_locked contract is REAL MONEY waiting on work, and the human's
// box may be off for days, so that event must escalate loudly, not sit in a feed nobody polls.
const DEALWORK_AGENT_ID = cfg.DEALWORK_AGENT_ID
async function dealworkRail() {
  const key = process.env.DEALWORK_API_KEY
  if (!key) return { skipped: 'no DEALWORK_API_KEY secret' }
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const out = {}
  try {
    // heartbeat is best-effort: a failure shouldn't hide bid/contract state below. It needs the
    // agent ID; bids and contracts only need the key.
    if (!DEALWORK_AGENT_ID) out.heartbeat = `skipped (${skipWhy('DEALWORK_AGENT_ID')})`
    else await fetch(`https://dealwork.ai/api/v1/agents/${DEALWORK_AGENT_ID}/heartbeat`, {
      method: 'POST', headers: H, body: JSON.stringify({ skillVersion: '1.4.0' }), signal: AbortSignal.timeout(10000),
    }).then((r) => { out.heartbeat = r.ok ? 'ok' : `HTTP ${r.status}` }).catch((e) => { out.heartbeat = `err:${e.message}` })
    const bids = await (await fetch('https://dealwork.ai/api/v1/bids/mine?per_page=20', { headers: H, signal: AbortSignal.timeout(10000) })).json()
    out.bids = (bids.data || []).map((b) => ({ id: b.id.slice(0, 8), job: (b.jobTitle || b.jobId || '').slice(0, 60), amount: b.proposedAmount, status: b.status }))
    const contracts = await (await fetch('https://dealwork.ai/api/v1/contracts?role=worker&per_page=20', { headers: H, signal: AbortSignal.timeout(10000) })).json()
    out.contracts = (contracts.data || []).map((c) => ({ id: c.id.slice(0, 8), state: c.state, amount: c.amount || c.escrowAmount }))
    out.actionable = out.contracts.filter((c) => ['escrow_locked', 'in_progress'].includes(c.state)).length
    return out
  } catch (e) { return { error: e.message, ...out } }
}

// toku.agency rail (registered 2026-07-10, agent echo-fable, autonomous onboard — pays real USD to
// a platform wallet; Stripe onboarding is only needed at withdrawal, same claim-at-end shape as
// Superteam). No webhook infra on our side, so poll the wallet: a balanceCents rise means someone
// actually hired/paid us and that must escalate loudly, not sit unread in a platform inbox.
async function tokuRail() {
  const key = process.env.TOKU_API_KEY
  if (!key) return { skipped: 'no TOKU_API_KEY secret' }
  try {
    const r = await fetch('https://www.toku.agency/api/agents/wallet', {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    // unread notifications = a hire or DM waiting; the platform has no push to us, so poll it here
    let unread = 0
    try {
      const n = await (await fetch('https://www.toku.agency/api/agents/notifications', {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
      })).json()
      unread = n.unreadCount || 0
    } catch {}
    return { balanceCents: d.balanceCents ?? 0, txs: (d.transactions || []).length, unread }
  } catch (e) { return { error: e.message } }
}

// GitHub PR watch (2026-07-05): our first real ugig rail is profullstack's pay-per-merged-PR bounty.
// Payment is OFF-platform + manual — he pays only AFTER a PR merges AND we send an invoice on ugig
// (no escrow guarantees it; the wallet watcher above catches the money itself). So we must catch the
// MERGE transition to trigger the invoice step, or a merged PR sits unbilled forever. Searches our
// authored PRs across the profullstack org; merged = pull_request.merged_at set. Fires once on a rise.
// Whose PRs, to which org: the PR_AUTHOR and PR_ORG settings (skipped unless both are set).
async function githubPrs() {
  const why = skipWhy('PR_AUTHOR', 'PR_ORG')
  if (why) return { skipped: why }
  try {
    const q = encodeURIComponent(`author:${cfg.PR_AUTHOR} type:pr org:${cfg.PR_ORG}`)
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'echo-earning-agent' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=50`, { headers, signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const prs = (d.items || []).map((p) => ({
      repo: (p.repository_url || '').split('/').pop(),
      num: p.number,
      title: (p.title || '').slice(0, 50),
      merged: Boolean(p.pull_request && p.pull_request.merged_at),
      state: p.state,
    }))
    return { total: prs.length, merged: prs.filter((p) => p.merged).length, prs }
  } catch (e) { return { error: e.message } }
}

// Solana-side USDC (second payment rail added 2026-07-05; receive-only wallet).
const SOL_WALLET = cfg.SOL_WALLET
async function solUsdc() {
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [SOL_WALLET, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, { encoding: 'jsonParsed' }],
      }),
    })
    const j = await r.json()
    return (j?.result?.value ?? []).reduce((s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0)
  } catch (e) { return `err:${e.message}` }
}

// Native SOL balance — chovy's ugig bounties pay in NATIVE SOL (payment_coin: "SOL"), which the
// USDC token-account query above never sees. Bounty submission 7895935a (sh1pt PR #763) pays here.
async function solNative() {
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL_WALLET] }),
    })
    const j = await r.json()
    return (j?.result?.value ?? 0) / 1e9
  } catch (e) { return `err:${e.message}` }
}

const usdc = EVM_WALLET ? await baseUsdc() : `skipped: ${skipWhy('EVM_WALLET')}`
const solUsdcBal = SOL_WALLET ? await solUsdc() : `skipped: ${skipWhy('SOL_WALLET')}`
const solNativeBal = SOL_WALLET ? await solNative() : `skipped: ${skipWhy('SOL_WALLET')}`
const superteam = await superteamLive()
// The token-intel service was taken offline on purpose in October 2026 (code kept as reference in
// Echolonius/token-intel-x402). Probing it only produced a daily "BROKEN" warning, so it's skipped.
// Flip SERVICE_RETIRED back to false if the service is ever redeployed.
const SERVICE_RETIRED = true
const service = SERVICE_RETIRED ? 'retired' : await serviceHealth()
const paidRoute = SERVICE_RETIRED ? 'retired' : await paidRouteHealth()
const intelPipeline = SERVICE_RETIRED ? 'retired' : await intelPipelineHealth()
const openTask = await openTaskRail()
const dealwork = await dealworkRail()
const toku = await tokuRail()
const github = await githubPrs()

// Saved state: history.jsonl (a line per run; each run compares against the last one) and
// seen-listings.json. state-repo.json names the repository they belong to, by its numeric ID,
// which stays the same through renames. A template copy or a fork starts out with the original's
// files, and comparing against them would make money already in the copy's wallets look like a new
// payment. So when the ID isn't this repository's (or the file is missing), the run starts fresh:
// it ignores those files, replaces them with its own and writes this repository's ID. Off GitHub
// Actions there's no ID to compare with, so the files are used as they are.
const HISTORY = new URL('./history.jsonl', import.meta.url)
const SEEN = new URL('./seen-listings.json', import.meta.url)
const STATE_REPO = new URL('./state-repo.json', import.meta.url)
const repoId = (process.env.GITHUB_REPOSITORY_ID || '').trim()
let stateRepoId = ''
try { stateRepoId = String(JSON.parse(readFileSync(STATE_REPO, 'utf8')).repositoryId ?? '') } catch {}
const freshStart = repoId !== '' && stateRepoId !== repoId

// Balance delta vs the previous run — a payment landing is THE profit event, so flag it loudly
// instead of leaving it as a quietly-changed number nobody reads.
// hasPrev: there is a previous run to compare with. Without one (a fresh start), this run only
// records a starting point: nothing counts as a new merge or contract, so it raises no alert.
// Likewise a PR check that was skipped last run (its settings weren't added yet) has no starting
// point (prevMerged null), so turning it on later doesn't report old merges as new.
let prevUsdc = null, prevSol = null, prevSolNative = null, prevActionable = 0, prevMerged = 0, prevTokuCents = null, prevOpenTaskLive = [], hasPrev = false
try {
  const lines = freshStart ? [] : readFileSync(HISTORY, 'utf8').trim().split('\n')
  if (lines.length) { const p = JSON.parse(lines[lines.length - 1]); hasPrev = true; if (typeof p.baseUsdc === 'number') prevUsdc = p.baseUsdc; if (typeof p.solUsdc === 'number') prevSol = p.solUsdc; if (typeof p.solNative === 'number') prevSolNative = p.solNative; prevActionable = p.dealwork?.actionable || 0; prevMerged = p.github?.skipped ? null : p.github?.merged || 0; if (typeof p.toku?.balanceCents === 'number') prevTokuCents = p.toku.balanceCents; prevOpenTaskLive = p.openTask?.live || [] }
} catch {}
const delta = (typeof usdc === 'number' && typeof prevUsdc === 'number') ? usdc - prevUsdc : 0
// ugig's PREFERRED payout is usdc_sol, so a real payment most likely lands on Solana — diff it too or
// the most-likely money event would change a number nobody's alerted to. Same transition-only rule.
const solDelta = (typeof solUsdcBal === 'number' && typeof prevSol === 'number') ? solUsdcBal - prevSol : 0
const solNativeDelta = (typeof solNativeBal === 'number' && typeof prevSolNative === 'number') ? solNativeBal - prevSolNative : 0
// A dealwork contract appearing means a bid was ACCEPTED and escrow is locked — work is owed and
// paid-for. Same transition-only alert discipline as payments: fire once when the count rises.
const newContract = hasPrev && (dealwork.actionable || 0) > prevActionable
// A PR just merged → the bounty is now billable; we must send the invoice on ugig. Fire once on a rise.
const newMerge = hasPrev && prevMerged !== null && (github.merged || 0) > prevMerged
// toku wallet is platform-custodied USD cents; a rise = someone paid for our work there. Transition-only.
const tokuDelta = (typeof toku.balanceCents === 'number' && typeof prevTokuCents === 'number') ? toku.balanceCents - prevTokuCents : 0

// Notify the human ONLY on the transition into a real event (money just landed, a bid accepted, a
// PR merged) — the workflow turns this sentinel into a failed run, which GitHub emails the repo owner.
// Writing it only on the transition means one email, not a failure on every subsequent run.
const notify = delta > 0 || solDelta > 0 || solNativeDelta > 0 || newContract || newMerge || tokuDelta > 0

// remember which listing slugs we have already seen, so we can flag genuinely NEW ones
let seen = []
if (!freshStart) { try { seen = JSON.parse(readFileSync(SEEN, 'utf8')) } catch {} }
const openSlugs = (superteam.open || []).map((o) => o.slug)
const fresh = openSlugs.filter((s) => !seen.includes(s))
const freshDetail = (superteam.open || []).filter((o) => fresh.includes(o.slug))
writeFileSync(SEEN, JSON.stringify([...new Set([...seen, ...openSlugs])], null, 0))

const snapshot = { ts: now, baseUsdc: usdc, solUsdc: solUsdcBal, solNative: solNativeBal, delta, solDelta, solNativeDelta, service, paidRoute, intelPipeline, openTask, dealwork, toku, github, superteam, newListings: fresh }
// A fresh start replaces the copied history instead of adding to it, and claims the state.
if (freshStart) {
  writeFileSync(HISTORY, JSON.stringify(snapshot) + '\n')
  writeFileSync(STATE_REPO, JSON.stringify({
    about: 'history.jsonl and seen-listings.json belong to this repository. In any other repository (a template copy or a fork), agent.mjs starts fresh instead of using them.',
    repository: process.env.GITHUB_REPOSITORY || '',
    repositoryId: repoId,
  }, null, 2) + '\n')
} else {
  appendFileSync(HISTORY, JSON.stringify(snapshot) + '\n')
}

// Shown at the top of status.md only when it applies: before any setting is added, and on a first run.
const SETTINGS_PAGE = 'Settings → Secrets and variables → Actions → Variables'
const notSetUp = ['EVM_WALLET', 'SOL_WALLET', 'PR_AUTHOR', 'PR_ORG'].every((n) => unset.includes(n))
const notes = [
  notSetUp ? `_Not set up yet: add your wallet addresses and other settings as repository variables (${SETTINGS_PAGE}). See the README._` : '',
  hasPrev ? '' : '_First run here: this run recorded a starting point. Alerts start from the next run._',
].filter(Boolean).map((n) => `\n${n}\n`).join('')

const md = `# Earning agent status

_Last run: ${now} (UTC), on GitHub Actions._
${notes}
## 💰 Wallet (real earnings land here)
- **Base USDC**${EVM_WALLET ? ` \`${EVM_WALLET}\`: **${usdc}**` : `: _${usdc}_`}${delta > 0 ? ` · 🎉 **+${delta.toFixed(6)} received since last run!**` : ''}
- **Solana USDC**${SOL_WALLET ? ` \`${SOL_WALLET}\`: **${solUsdcBal}**` : `: _${solUsdcBal}_`}${solDelta > 0 ? ` · 🎉 **+${solDelta.toFixed(6)} received since last run!**` : ''}
- **Solana (native SOL)**${SOL_WALLET ? `: **${solNativeBal}**` : `: _${solNativeBal}_`}${solNativeDelta > 0 ? ` · 🎉 **+${solNativeDelta.toFixed(9)} SOL received since last run!**` : ''}

## 🛰️ Paid service (Solana Token Intelligence, x402)
- ${SERVICE_RETIRED ? '**Retired** (offline on purpose since October 2026; code kept at [token-intel-x402](https://github.com/Echolonius/token-intel-x402))' : `${SERVICE} — service **${service}** · paid-route **${paidRoute}** · intel **${intelPipeline}**`}

## 🔀 Alt rails (widening the net beyond Superteam)
- **OpenTask** router: **${openTask.state}**${openTask.live?.length ? ` · live methods: ${openTask.live.join(', ')}` : ' _(watching for revival)_'}
- **dealwork.ai**: ${dealwork.skipped ? `_${dealwork.skipped}_` : dealwork.error ? `_err: ${dealwork.error}_` : `heartbeat **${dealwork.heartbeat}** · bids: ${dealwork.bids?.map((b) => `${b.status} $${b.amount}`).join(', ') || 'none'} · contracts: ${dealwork.contracts?.length ? dealwork.contracts.map((c) => `${c.state} $${c.amount ?? '?'}`).join(', ') : 'none'}${dealwork.actionable ? ' · ⚡ **ESCROW LOCKED — WORK IS OWED, open a session**' : ''}`}
- **toku.agency** (real-USD wallet): ${toku.skipped ? `_${toku.skipped}_` : toku.error ? `_err: ${toku.error}_` : `balance **$${((toku.balanceCents || 0) / 100).toFixed(2)}** · ${toku.txs} transactions · ${toku.unread || 0} unread${toku.unread ? ' · 📬 **UNREAD NOTIFICATION — possible hire/DM, open a session**' : ''}${tokuDelta > 0 ? ` · 🎉 **+$${(tokuDelta / 100).toFixed(2)} earned since last run!**` : ''}`}

## 🔧 ${cfg.PR_ORG || 'GitHub'} PR bounties (pay-per-merged-PR; invoice required after merge)
- ${github.skipped ? `_skipped: ${github.skipped}_` : github.error ? `_err: ${github.error}_` : github.prs?.length ? `${github.merged}/${github.total} merged · ${github.prs.map((p) => `${p.merged ? '✅' : p.state === 'closed' ? '❌' : '⏳'} ${p.repo}#${p.num}`).join(', ')}${newMerge ? ' · 💵 **A PR JUST MERGED — SEND THE INVOICE NOW**' : ''}` : '_no PRs found yet_'}

## 🎯 Open agent listings (Superteam) — AGENT_ONLY first (lowest competition)
${superteam.skipped ? `_scan skipped: ${superteam.skipped}_`
  : superteam.error ? `_scan error: ${superteam.error}_`
  : (superteam.open?.length
      ? superteam.open.map((o) => `- ${o.access === 'AGENT_ONLY' ? '🔒 **AGENT_ONLY**' : 'open'} · \`${o.slug}\` — ${o.type} · ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')
      : '_none open right now_')}

${fresh.length ? `## 🆕 New since last run\n${freshDetail.map((o) => `- ${o.access === 'AGENT_ONLY' ? '🔒 AGENT_ONLY' : 'open'} · \`${o.slug}\` — ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')}` : ''}

---
_This file is rewritten by \`agent.mjs\` on every scheduled run. History in \`history.jsonl\`._
`
writeFileSync(new URL('./status.md', import.meta.url), md)

// The notification sentinel: present ONLY on a transition run. The workflow's final step fails the
// run when it exists (→ GitHub emails the repo owner), then it's cleared on the next run so a single
// event produces a single alert. This is our no-signup push channel; the human also has the always-
// current status.md and can just ask. Written AFTER status.md so a commit still captures state.
const NOTIFY = new URL('./NOTIFY.txt', import.meta.url)
if (notify) {
  const msg = (delta > 0 || solDelta > 0 || solNativeDelta > 0)
    ? `💰 PAYMENT RECEIVED (${now}) — ${delta > 0 ? `+${delta.toFixed(6)} USDC on Base (total ${usdc})` : ''}${delta > 0 && solDelta > 0 ? ' + ' : ''}${solDelta > 0 ? `+${solDelta.toFixed(6)} USDC on Solana (total ${solUsdcBal})` : ''}${solNativeDelta > 0 ? ` +${solNativeDelta.toFixed(9)} native SOL (total ${solNativeBal})` : ''}`
    : tokuDelta > 0
    ? `💰 TOKU PAYMENT (${now}) — +$${(tokuDelta / 100).toFixed(2)} in the toku.agency wallet (total $${((toku.balanceCents || 0) / 100).toFixed(2)}); withdrawal needs one-time Stripe onboarding`
    : newMerge
    ? `💵 PR MERGED (${now}) — a ${cfg.PR_ORG} PR was merged; send the invoice now to get paid`
    : newContract
    ? `⚡ DEALWORK BID ACCEPTED (${now}) — escrow locked, work is owed; open a Claude session to deliver`
    : `event (${now})`
  writeFileSync(NOTIFY, msg + '\n')
} else {
  try { unlinkSync(NOTIFY) } catch {}
}

// Settings help for copies: a warning on the run summary until any wallet or PR setting is added,
// then a plain log line for whatever is still unset. DEALWORK_AGENT_ID only matters with its key.
const stillUnset = unset.filter((n) => n !== 'DEALWORK_AGENT_ID' || process.env.DEALWORK_API_KEY)
if (notSetUp) console.log(`::warning title=Not set up yet::No settings found, so the wallet and PR checks were skipped. Add repository variables under ${SETTINGS_PAGE}: EVM_WALLET (Base wallet), SOL_WALLET (Solana wallet), PR_AUTHOR and PR_ORG (whose PRs to track, to which org). All optional; see the README.`)
else if (stillUnset.length) console.log(`Not set, so their checks were skipped: ${stillUnset.join(', ')} (add under ${SETTINGS_PAGE})`)
if (wrong.length) console.log(`::warning title=Setting doesn't look right::Skipped the checks that need ${wrong.join(', ')}: the value doesn't look right. Fix it under ${SETTINGS_PAGE}.`)
if (freshStart) console.log(`::notice title=Started fresh::The saved state here ${stateRepoId ? 'belongs to another repository' : 'has no state-repo.json'}, so this run ignored it and recorded a starting point. Alerts start from the next run.`)
console.log('status:', JSON.stringify(snapshot))
// Loud CI signals for the events that actually matter — these surface in the Actions run summary.
if (delta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${delta.toFixed(6)} USDC landed on Base — total ${usdc}`)
if (solDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solDelta.toFixed(6)} USDC landed on Solana — total ${solUsdcBal}`)
if (solNativeDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solNativeDelta.toFixed(9)} native SOL landed — total ${solNativeBal}`)
if (newMerge) console.log(`::notice title=PR MERGED::a ${cfg.PR_ORG} PR merged — send the invoice now`)
if (hasPrev && openTask.live?.length && !openTask.live.every((m) => prevOpenTaskLive.includes(m))) console.log(`::notice title=OPENTASK RAIL LIVE::methods ${openTask.live.join(', ')} — a new earning source just opened`)
if (newContract) console.log('::notice title=DEALWORK BID ACCEPTED::escrow locked — work is owed, open a session to deliver')
if (tokuDelta > 0) console.log(`::notice title=TOKU PAYMENT::+$${(tokuDelta / 100).toFixed(2)} USD landed in the toku.agency wallet — total $${((toku.balanceCents || 0) / 100).toFixed(2)}`)
if (toku.unread) console.log(`::notice title=TOKU UNREAD::${toku.unread} unread toku notification(s) — possible hire or DM`)
if (!SERVICE_RETIRED && String(paidRoute).startsWith('BROKEN')) console.log(`::warning title=SALES PATH DOWN::${paidRoute}`)
if (freshDetail.length) console.log('::notice title=NEW LISTINGS::' + freshDetail.map((o) => `${o.slug} (${o.access}, ${o.reward} ${o.token})`).join(' | '))
