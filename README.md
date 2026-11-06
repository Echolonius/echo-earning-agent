# echo-earning-agent

The **always-on watcher** of our earning agent. It runs on GitHub Actions — i.e. on GitHub's
servers, on a schedule, **whether or not any home computer is on**. It doesn't do paid work or
move money itself: it checks whether money or work has arrived and raises a flag when it has.

**So far no payment has shown up:** every wallet balance it has read since the first run in
July 2026 was 0 (see [`history.jsonl`](history.jsonl)).

Once a day it:
1. reads the on-chain balances of our two receive-only wallets (USDC on Base; USDC and native
   SOL on Solana) — any payment shows up in [`status.md`](status.md);
2. scans [Superteam](https://superteam.fun)'s agent-listing API for open bounties worth
   entering, flagging anything new since the last run (needs `SUPERTEAM_API_KEY`);
3. checks other places work could come from: whether OpenTask's payment router is accepting
   payments (public, no key), our dealwork.ai bids and contracts, and our toku.agency wallet
   (each of the last two only if its API key is set);
4. checks our pull requests to the profullstack GitHub org (a pay-per-merged-PR bounty) and
   flags a new merge, because payment there only comes after we send an invoice;
5. commits a fresh `status.md`, appends `history.jsonl` and updates `seen-listings.json`, so
   progress is visible any time you glance at the repo — no terminal, no local process.

When something real happens — a wallet or toku balance goes up, a dealwork bid is accepted, or a
tracked PR merges — the run is **marked failed on purpose**, so GitHub's failed-run email works
as the alert (once per event). So a red ❌ run may be that alert rather than a bug; its summary
says which.

**Safety:** this repo holds **no private keys**, and the agent never spends or signs anything —
that stays offline on the operator's machine. API keys live in GitHub Actions secrets, not in the
code. It reads public chain data and listings, plus our own dealwork.ai and toku.agency account
data when those keys are set. Outside this repo, the only thing it changes is dealwork's
"still alive" heartbeat for our agent.

### Running your own copy (forks)
Out of the box a fork watches **our** accounts, not yours. Before relying on it, change these
values in [`agent.mjs`](agent.mjs):

- `EVM_WALLET` and `SOL_WALLET`: the wallets whose balances it reads;
- `DEALWORK_AGENT_ID`: the dealwork.ai agent it sends the heartbeat for;
- the search in `githubPrs()` (`author:Echolonius type:pr org:profullstack`): whose PRs it tracks.

Left as they are, your fork reports our balances and PRs, and raises the alert (a failed run)
when one of *ours* changes.

Secrets go in your fork under **Settings → Secrets and variables → Actions**. All of them are
optional; with none set it still reads the wallets, OpenTask and the PR search.

| Secret | Used for | Without it |
|---|---|---|
| `SUPERTEAM_API_KEY` | Superteam agent-listing scan | scan skipped |
| `DEALWORK_API_KEY` | dealwork.ai heartbeat, bids and contracts | check skipped |
| `TOKU_API_KEY` | toku.agency wallet balance and unread notifications | check skipped |

`GITHUB_TOKEN` is provided by GitHub automatically; don't add it yourself.

Before you switch it on, know that:
- GitHub turns scheduled workflows off in a new fork; you enable them in your fork's **Actions**
  tab.
- Every run commits `status.md`, `history.jsonl` and `seen-listings.json` to your default branch,
  with a token that can push to your repo.
- A fork of a public repo is public too, so everything it records is public: the wallet balances
  and, if you add the dealwork or toku keys, your bids, contract amounts, toku balance and unread
  count.
- A failed run can be the intended alert (see above) rather than a breakage.
- Older versions of the workflow committed with our account's email, so a fork's status commits
  were credited to our GitHub account. It now commits as `github-actions[bot]`; to pick that up,
  copy the two `git config` lines from our `.github/workflows/agent.yml` into yours (syncing the
  whole fork may conflict with your own status commits).

### Roadmap (making money land while you're away)
- [ ] Auto-draft + submit to fitting agent bounties (quality-gated, never spam)
- [ ] Notify on new high-value listings (new listings already show in `status.md` and as a
      notice on the run, but they don't trigger the alert email)

Dropped: hosting the x402 paid service off-box and keeping its discovery listings fresh. The
service was taken offline on purpose in October 2026 (code kept in
[token-intel-x402](https://github.com/Echolonius/token-intel-x402)).

### Retired: Imperial hackathon watch (removed 2026-10-20)
The agent used to track our entry in Superteam's Imperial AI Agent Hackathon and raise an alert
when winners were announced. That happened, but we stopped there instead of claiming:

- **Claiming happens inside the platform.** Prizes are redeemed through Superteam's own claim page
  and account flow. They aren't paid straight to the receive-only wallets above, and the agent
  can't finish that step by itself or anonymously.
- **It was never clear what was owed.** The listing said winners were out, but nothing confirmed
  whether this entry placed or how a payout would reach a wallet.
- **Lesson:** a contest run inside one platform's own system is a poor fit for an agent that can
  only receive money at a public address. Prefer open-market work that pays a wallet directly on
  delivery, or uses escrow.
