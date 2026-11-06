# echo-earning-agent

A small watcher that runs **once a day on GitHub Actions**, on GitHub's servers, so no computer of
yours needs to be on. Make your own copy and it gives you:

- **a daily check of your wallets**: the USDC balance of a Base wallet, and the USDC and native SOL
  balances of a Solana wallet;
- **a daily check of bounty boards**: open agent bounties on [Superteam](https://superteam.fun)
  (needs a Superteam API key) and whether OpenTask's payment router is taking payments; with their
  API keys, also your dealwork.ai bids and contracts and your toku.agency wallet; and, if you do
  pay-per-merged-PR bounties, your pull requests to one GitHub organization;
- **an alert when a payment lands**: when a watched balance goes up, a dealwork bid is accepted or
  a tracked pull request merges, the run is marked failed on purpose, so GitHub's failed-run email
  is your alert, once per event.

It **never spends money**: it holds no private keys and never signs anything, and API keys stay in
GitHub Actions secrets, not in the code. It reads, and writes what it finds to `status.md` in your
copy.

## Set up your copy in 3 steps

1. **Copy it.** At the top of this page, click **Use this template → Create a new repository**.
   Choose **Private** to keep your wallets and results to yourself.
2. **Add your settings.** In your copy, open **Settings → Secrets and variables → Actions**. On the
   **Variables** tab, add the settings you want from the table below (most people start with
   `EVM_WALLET` and `SOL_WALLET`). Put any API keys on the **Secrets** tab.
3. **Run it.** In the **Actions** tab, open **earning-agent** and click **Run workflow** (if GitHub
   asks, enable workflows first). From then on it runs by itself once a day; open `status.md` to
   see what it found.

## Settings

All optional. A check whose setting is missing is skipped, and the run's log names the variable to
add; with none set, a run only checks OpenTask (and Superteam, if you added its key). Settings and
secrets are never copied along with the template or a fork, so a copy can't see ours.

| Variable | What to put in it | Turns on |
|---|---|---|
| `EVM_WALLET` | your Base wallet address (`0x…`) | its USDC balance check |
| `SOL_WALLET` | your Solana wallet address | its USDC and native SOL balance checks |
| `PR_AUTHOR` | a GitHub username | tracking that user's pull requests… |
| `PR_ORG` | a GitHub organization | …to that organization (set both) |
| `DEALWORK_AGENT_ID` | your dealwork.ai agent ID | dealwork's "still alive" heartbeat (also needs `DEALWORK_API_KEY`) |

| Secret | Used for | Without it |
|---|---|---|
| `SUPERTEAM_API_KEY` | Superteam agent-listing scan | scan skipped |
| `DEALWORK_API_KEY` | dealwork.ai heartbeat, bids and contracts | check skipped |
| `TOKU_API_KEY` | toku.agency wallet balance and unread notifications | check skipped |

`GITHUB_TOKEN` is provided by GitHub automatically; don't add it yourself.

## Good to know

- **The first run starts fresh.** A new copy contains our saved state (`history.jsonl` and
  `seen-listings.json`). `state-repo.json` records which repository that state belongs to, so your
  copy's first run ignores ours, replaces those files with its own and only records a starting
  point: alerts start from the second run. On that first run every open Superteam listing counts as
  new. To start over later, delete `state-repo.json`.
- **A red run may be the alert**, not a breakage; its summary says which.
- **New listings** show in `status.md` and as a notice on the run, but don't trigger the alert email.
- **Every run commits** `status.md`, `history.jsonl` and `seen-listings.json` (and, on the first
  run, `state-repo.json`) to your default branch, as `github-actions[bot]`. An alert run also
  commits `NOTIFY.txt` with the alert message; the next run without an event deletes it.
- **Outside your copy**, the only thing it changes is dealwork's "still alive" heartbeat, sent only
  when `DEALWORK_API_KEY` and `DEALWORK_AGENT_ID` are both set. Everything else is a read.
- **A public copy shows everything it records**: your wallet addresses and balances and, with the
  dealwork or toku keys, your bids, contract amounts, toku balance and unread count. A private copy
  keeps that to you; its runs use your account's GitHub Actions minutes (one short job a day).

## Already running a fork?

Thanks for running it! In older forks our values are written into `agent.mjs` (you'll see
`EVM_WALLET = '0x…'` near the top): unless you edited them, your fork reads our wallets and tracks
our pull requests, not yours. To switch to settings:

1. Add your values as variables in your fork (see [Settings](#settings)), including any you had
   edited into `agent.mjs`.
2. Replace your `agent.mjs` and `.github/workflows/agent.yml` with the current ones from this repo.
   Copying these two files is easier than syncing the whole fork, which may conflict with your own
   status commits.
3. The next run starts fresh: it ignores and replaces `history.jsonl` and `seen-listings.json` and
   raises no alert. After that it works as before.

Also worth knowing:
- A fork of a public repo is always public, so it shows your wallets, balances and bids. To keep
  them private, make a private copy with **Use this template** instead, and turn off your fork's
  workflow in its **Actions** tab.
- GitHub turns scheduled workflows off in a new fork; you turn them on in the fork's **Actions** tab.
- Older versions of the workflow committed with our account's email, so a fork's status commits
  were credited to our account. The current workflow commits as `github-actions[bot]`.

## Our own run

This repository is the original and watches our own wallets and accounts; see
[`status.md`](status.md). **So far no payment has shown up:** every wallet balance it has read
since the first run in July 2026 was 0 (see [`history.jsonl`](history.jsonl)).

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

## License
Released under the [MIT License](LICENSE).
