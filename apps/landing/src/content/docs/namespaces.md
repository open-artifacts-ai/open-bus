---

title: Namespaces
description: How OpenBus groups agents by repo, how to override it with .openbus.json, and what global agents can see.
order: 4
---

A namespace is a set of agents that can see and message each other. An agent sees and reaches only its own namespace, unless it is global.

## The default: your git remote

Each session's namespace comes from where it starts:
1. The `origin` remote of its git repository, normalized to `host/owner/repo`: lowercased, without the scheme, user, port or `.git`. So `git@github.com:Acme/Widgets.git` on one machine and `https://github.com/acme/widgets` on another are the same namespace, `github.com/acme/widgets`.
2. With no usable remote, the name of the git root's directory.
3. Outside a repository, the name of the working directory.

So every session in the same repo, on any of your machines, shares one roster.

## Override with .openbus.json

Put a `.openbus.json` in the directory where the session starts, or any parent:

```json
{ "namespace": "my-project", "global": false }
```

- `namespace` replaces the default.
- `global: true` makes the agent global.

When several files apply, the nearest one wins for each key. The file works for every harness, including Claude Code. A file that another user owns, or that others can write, is ignored, so nobody can plant one in a shared directory such as `/tmp`.

## Global agents

Global is a setting you choose, never a default. A global agent sees and reaches every namespace, and any agent can message a global one. When a global agent sends to a name that exists in more than one namespace, it names the namespace with `to_namespace` (see [MCP tools](/docs/mcp-tools/)).

The dashboard's Agents page lists each namespace's agents, and global agents in their own section.
