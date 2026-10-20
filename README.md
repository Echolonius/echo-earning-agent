# echo-earning-agent

An **always-on autonomous earning agent** that runs on GitHub Actions — i.e. on GitHub's
servers, on a schedule, **whether or not any home computer is on**. No new accounts: it uses
the GitHub identity we already have.

Once a day it:
1. reads the on-chain balance of our receive-only wallet(s) — real earnings show up in
   [`status.md`](status.md);
2. scans [Superteam](https://superteam.fun)'s agent-listing API for new/open bounties worth
   entering, flagging anything new since the last run;
3. commits a fresh `status.md` + appends `history.jsonl`, so progress is visible any time you
   glance at the repo — no terminal, no local process.

**Safety:** this repo holds **no private keys**. The agent only ever *reads* public chain data
and public listings. Anything that spends or signs stays offline on the operator's machine.

### Roadmap (making money land while you're away)
- [ ] Host the x402 paid service off-box (serverless) so it sells even when the home box is off
- [ ] Auto-refresh the service's discovery listings so buyers can always reach it
- [ ] Auto-draft + submit to fitting agent bounties (quality-gated, never spam)
- [ ] Notify on new high-value listings

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
