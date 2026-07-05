/**
 * Always-on earning agent — runs on GitHub Actions cron (GitHub's servers, alive when the
 * home box is off). Dependency-free: Node 20+ global fetch only. Each run:
 *   1. reads on-chain balances of our receive-only wallets (real earnings show up here)
 *   2. scans Superteam's agent listings for new/open bounties we could win
 *   3. writes a timestamped status.md + appends history.jsonl, which the workflow commits
 *
 * Secrets (GitHub repo → Settings → Secrets): SUPERTEAM_API_KEY (optional; scan skipped without it).
 * No private keys ever live here — this process only READS. Earning/spending stays offline.
 */
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'

const EVM_WALLET = '0xd194AB36E66BccDD80f19b56757CFe52EdEd49af' // Base USDC receive-only
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

// Watch our submitted hackathon specifically — it drops off the "live" feed after its deadline,
// but we still need to catch the winners announcement (submission 7ed59a67, ~$500–3000 if we place).
async function hackathonStatus() {
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: true }
  try {
    const r = await fetch('https://superteam.fun/api/agents/listings/details/imperial-ai-agent-hackathon-build-the-agent-economy', { headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const l = d.listing || d
    return { status: l.status, isActive: l.isActive, winnersAnnounced: l.isWinnersAnnounced ?? l.winnersAnnouncedAt ?? null }
  } catch (e) { return { error: e.message } }
}

// Solana-side USDC (second payment rail added 2026-07-05; receive-only wallet).
const SOL_WALLET = '3wbinZDnWmDxHMLtACNrskwZvRwg4KYbBWw1wuviXXHT'
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

const usdc = await baseUsdc()
const solUsdcBal = await solUsdc()
const superteam = await superteamLive()
const service = await serviceHealth()
const paidRoute = await paidRouteHealth()
const intelPipeline = await intelPipelineHealth()
const openTask = await openTaskRail()
const hackathon = await hackathonStatus()

// Balance delta vs the previous run — a payment landing is THE profit event, so flag it loudly
// instead of leaving it as a quietly-changed number nobody reads. Also carry forward the previous
// winners state so we can notify only on the TRANSITION (fire once, not every run forever).
let prevUsdc = null, prevWinners = false
try {
  const lines = readFileSync(new URL('./history.jsonl', import.meta.url), 'utf8').trim().split('\n')
  if (lines.length) { const p = JSON.parse(lines[lines.length - 1]); if (typeof p.baseUsdc === 'number') prevUsdc = p.baseUsdc; prevWinners = Boolean(p.winnersFired) }
} catch {}
const delta = (typeof usdc === 'number' && typeof prevUsdc === 'number') ? usdc - prevUsdc : 0

// Robust winners watch: this fires exactly once, after Jul 6, and CANNOT be tested until then — so
// treat ANY truthy signal as fired and shout. This is the $500–3000 event; it must not fail quietly.
const winnersFired = Boolean(hackathon.winnersAnnounced)
// Notify the human ONLY on the transition into a real event (winners just announced, or money just
// landed) — the workflow turns this sentinel into a failed run, which GitHub emails the repo owner.
// Writing it only on the transition means one email, not a failure on every subsequent run.
const justWon = winnersFired && !prevWinners
const notify = justWon || delta > 0

// remember which listing slugs we have already seen, so we can flag genuinely NEW ones
let seen = []
try { seen = JSON.parse(readFileSync(new URL('./seen-listings.json', import.meta.url), 'utf8')) } catch {}
const openSlugs = (superteam.open || []).map((o) => o.slug)
const fresh = openSlugs.filter((s) => !seen.includes(s))
const freshDetail = (superteam.open || []).filter((o) => fresh.includes(o.slug))
writeFileSync(new URL('./seen-listings.json', import.meta.url), JSON.stringify([...new Set([...seen, ...openSlugs])], null, 0))

const snapshot = { ts: now, baseUsdc: usdc, delta, service, paidRoute, intelPipeline, openTask, hackathon, winnersFired, superteam, newListings: fresh }
appendFileSync(new URL('./history.jsonl', import.meta.url), JSON.stringify(snapshot) + '\n')

const md = `# Earning agent status

_Last run: ${now} (UTC), on GitHub Actions._

## 💰 Wallet (real earnings land here)
- **Base USDC** \`${EVM_WALLET}\`: **${usdc}**${delta > 0 ? ` · 🎉 **+${delta.toFixed(6)} received since last run!**` : ''}
- **Solana USDC** \`${SOL_WALLET}\`: **${solUsdcBal}**

## 🛰️ Paid service (Solana Token Intelligence, x402)
- ${SERVICE} — service **${service}** · paid-route **${paidRoute}** · intel **${intelPipeline}** · listed on 402index.io

## 🔀 Alt rails (widening the net beyond Superteam)
- **OpenTask** router: **${openTask.state}**${openTask.live?.length ? ` · LIVE methods: ${openTask.live.join(', ')} — ACT NOW` : ' _(watching for revival; speaks x402-v2 our service already supports)_'}

## 🏆 Imperial hackathon (our submission 7ed59a67 — ~$500–3000 if we place)
- listing status: **${hackathon.status ?? hackathon.error ?? 'n/a'}**${winnersFired ? ` · 🏆 **WINNERS ANNOUNCED — CHECK CLAIM: superteam.fun/earn/claim/415BE325D969CE8A28E7EC7A**` : ''}

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
  const msg = justWon
    ? `🏆 HACKATHON WINNERS ANNOUNCED (${now}) — claim at superteam.fun/earn/claim/415BE325D969CE8A28E7EC7A`
    : `💰 PAYMENT RECEIVED (${now}) — +${delta.toFixed(6)} USDC on Base, total ${usdc}`
  writeFileSync(NOTIFY, msg + '\n')
} else {
  try { unlinkSync(NOTIFY) } catch {}
}

console.log('status:', JSON.stringify(snapshot))
// Loud CI signals for the events that actually matter — these surface in the Actions run summary.
if (delta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${delta.toFixed(6)} USDC landed on Base — total ${usdc}`)
if (winnersFired) console.log('::notice title=HACKATHON WINNERS ANNOUNCED::claim at superteam.fun/earn/claim/415BE325D969CE8A28E7EC7A')
if (openTask.live?.length) console.log(`::notice title=OPENTASK RAIL LIVE::methods ${openTask.live.join(', ')} — a new earning source just opened`)
if (String(paidRoute).startsWith('BROKEN')) console.log(`::warning title=SALES PATH DOWN::${paidRoute}`)
if (freshDetail.length) console.log('::notice title=NEW LISTINGS::' + freshDetail.map((o) => `${o.slug} (${o.access}, ${o.reward} ${o.token})`).join(' | '))
