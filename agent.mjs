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
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs'

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
      .map((l) => ({ slug: l.slug, type: l.type, reward: l.rewardAmount, token: l.token, deadline: (l.deadline || '').slice(0, 10) }))
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

const usdc = await baseUsdc()
const superteam = await superteamLive()
const service = await serviceHealth()
const hackathon = await hackathonStatus()

// remember which listing slugs we have already seen, so we can flag genuinely NEW ones
let seen = []
try { seen = JSON.parse(readFileSync(new URL('./seen-listings.json', import.meta.url), 'utf8')) } catch {}
const openSlugs = (superteam.open || []).map((o) => o.slug)
const fresh = openSlugs.filter((s) => !seen.includes(s))
writeFileSync(new URL('./seen-listings.json', import.meta.url), JSON.stringify([...new Set([...seen, ...openSlugs])], null, 0))

const snapshot = { ts: now, baseUsdc: usdc, service, hackathon, superteam, newListings: fresh }
appendFileSync(new URL('./history.jsonl', import.meta.url), JSON.stringify(snapshot) + '\n')

const md = `# Earning agent status

_Last run: ${now} (UTC), on GitHub Actions._

## 💰 Wallet (real earnings land here)
- **Base USDC** \`${EVM_WALLET}\`: **${usdc}**

## 🛰️ Paid service (Solana Token Intelligence, x402)
- ${SERVICE} — **${service}** · listed on 402index.io

## 🏆 Imperial hackathon (our submission 7ed59a67 — ~$500–3000 if we place)
- listing status: **${hackathon.status ?? hackathon.error ?? 'n/a'}**${hackathon.winnersAnnounced ? ` · WINNERS ANNOUNCED: ${hackathon.winnersAnnounced}` : ''}

## 🎯 Open agent listings (Superteam)
${superteam.skipped ? `_scan skipped: ${superteam.skipped}_`
  : superteam.error ? `_scan error: ${superteam.error}_`
  : (superteam.open?.length
      ? superteam.open.map((o) => `- \`${o.slug}\` — ${o.type} · ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')
      : '_none open right now_')}

${fresh.length ? `## 🆕 New since last run\n${fresh.map((s) => `- ${s}`).join('\n')}` : ''}

---
_This file is rewritten by \`agent.mjs\` on every scheduled run. History in \`history.jsonl\`._
`
writeFileSync(new URL('./status.md', import.meta.url), md)
console.log('status:', JSON.stringify(snapshot))
if (fresh.length) console.log('::notice::NEW listings:', fresh.join(', '))
