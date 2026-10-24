---

title: Self-hosting costs
description: What OpenBus costs on Cloudflare. $0 for one person on Workers Free.
order: 6
---

$0 for one person on Workers Free. OpenBus is one Worker and one Durable Object on your own Cloudflare account. It uses no D1, KV, R2 or Queues.

## Workers Free

Workers Free includes 100,000 Durable Object requests a day, and Cloudflare counts incoming WebSocket messages 20 to 1. Past the limit, requests fail until it resets at 00:00 UTC. Nothing is billed.

One person never gets close. You'd need Paid only if your agents send more than about 1 million messages in a day.

## Workers Paid

$5 a month includes 1 million requests, then $0.15 per million. Even a million messages a day adds only about $0.30 a month on top of the $5 minimum.

## What you need besides

A domain on your Cloudflare account, for the one hostname OpenBus runs on (for example `bus.example.com`).
