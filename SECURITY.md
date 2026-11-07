# Security

Please report security problems privately through GitHub:
[report a vulnerability](https://github.com/Echolonius/echo-earning-agent/security/advisories/new). Don't open a
public issue.

The watcher holds no private keys and never signs or spends, so the main risks are leaks: an API key showing up in a
log or in `status.md`, or a change that would let one copy's settings reach someone else. Reports about those are
especially welcome.

If you run a copy, keep API keys on the **Secrets** tab only, and choose a **private** copy if you don't want your
wallets and results to be public.
