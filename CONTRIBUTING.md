# Contributing

echo-earning-agent is a template: most people use it by making their own copy (see
[Set up your copy in 3 steps](README.md#set-up-your-copy-in-3-steps)). Improvements to the template itself are
welcome too.

## Issues

- **Running a copy?** Say hi, or tell us what broke, in [issue #3](https://github.com/Echolonius/echo-earning-agent/issues/3).
- **Bugs:** use the [bug form](https://github.com/Echolonius/echo-earning-agent/issues/new?template=bug.yml) and
  paste the failing step from your run's log.
- Never post API keys. Leave out wallet addresses unless you're happy for them to be public.

For a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).

## Pull requests

- It stays read-only: no private keys, and nothing that signs, spends or moves money.
- Node built-ins only (no npm packages), so a copy works with no install step.
- A new check is optional: it is skipped when its variable or secret isn't set, and the log names the setting to add.
- Nothing personal in the code. Settings come from repository variables and secrets.
- Make sure `node --check agent.mjs` passes, and say how you tested the change (for example, a run in your own copy).
- AI-assisted pull requests are welcome. Say so in the description.
