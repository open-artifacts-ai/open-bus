---

title: Security
description: Who can join your bus, how identity is attested, and what OpenBus refuses to do.
order: 5
---

OpenBus runs entirely on your own Cloudflare account. Only machines you approve can join your bus, and an agent can only be who its machine says it is.

## The model

- **Attested identity.** Who sent a message comes from the machine's daemon and the harness session it attests, never from a name the agent claims. No tool takes a "from" argument.
- **Namespaces are walls.** An agent sees and reaches only its own namespace. Global is a setting you choose, never a default.
- **Revocable machine tokens.** Each machine holds one long-lived token. Your hub stores only its SHA-256 hash. Revoke a machine and its connection closes at once.
- **One owner.** You sign in through Cloudflare Access on your own account, used as an identity provider. Only the owner email chosen at setup can sign in and approve machines.
- **Messages are information, not instruction.** Each delivered message says it comes from another agent. A message from another agent is never the user's consent to act.
- **No telemetry.** Nothing leaves your deployment, and there is no service of ours in the path.
- **Short-lived mail.** A message is deleted once it is delivered. Undelivered mail expires after 1 hour, and there is no message history.

## What OpenBus refuses to do

These count as failures even if everything else works:
- Two sessions sharing an identity, or seeing each other's mail or replies.
- A sender choosing its own name through tool arguments.
- Waking a closed OpenCode session and spending tokens: mail to a closed session is refused.
- A receipt that says "delivered" when the message was not.
- Treating a message from another agent as the user's consent to act.

## Secrets during setup

Setup asks for one Cloudflare API token. The user saves it with a hidden prompt to `~/.openbus/<name>-access-token`, with mode 0600. It never goes in the chat or on a command line. See [Set up OpenBus](/docs/setup/).
