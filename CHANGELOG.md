# Changelog

## [0.28.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.27.0...v0.28.0) (2026-10-24)


### Features

* **hub:** B10-ws dashboard WebSocket feed replaces SSE ([#152](https://github.com/open-artifacts-ai/open-bus/issues/152)) ([8593972](https://github.com/open-artifacts-ai/open-bus/commit/8593972c4380d544597b728ff7b64a411c6c54d0))

## [0.27.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.26.0...v0.27.0) (2026-10-24)


### Features

* **cli:** run the daemon as a launchd or systemd user service (C9) ([#151](https://github.com/open-artifacts-ai/open-bus/issues/151)) ([28e48ae](https://github.com/open-artifacts-ai/open-bus/commit/28e48ae71806bcd4b29f57200fe1eb364235ddca))
* **dashboard:** live updates over a WebSocket ([#150](https://github.com/open-artifacts-ai/open-bus/issues/150)) ([dadb36b](https://github.com/open-artifacts-ai/open-bus/commit/dadb36b65ceab8614b7e03c0fda0811085fe80d4))

## [0.26.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.25.0...v0.26.0) (2026-10-24)


### Features

* **hub:** B9-hub revoke a machine, close 4403, refuse revoked mail ([#145](https://github.com/open-artifacts-ai/open-bus/issues/145)) ([50ca4e3](https://github.com/open-artifacts-ai/open-bus/commit/50ca4e36bd7c496a4f528b3485cd3f07a7a8c5dd))

## [0.25.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.24.0...v0.25.0) (2026-10-24)


### Features

* **cli:** add install, status, doctor, uninstall and daemon commands (C8b) ([#143](https://github.com/open-artifacts-ai/open-bus/issues/143)) ([291e88e](https://github.com/open-artifacts-ai/open-bus/commit/291e88e00404e96f99a615b976a83aff8622b478))
* **hub:** B10-hub dashboard DTOs, listAgents, /events observer feed ([#144](https://github.com/open-artifacts-ai/open-bus/issues/144)) ([0b9677a](https://github.com/open-artifacts-ai/open-bus/commit/0b9677adeb818f70cd34d897aa384419be4f3926))

## [0.24.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.23.1...v0.24.0) (2026-10-24)


### Features

* **hub:** B8 fetch by id, namespace and global matrix ([#140](https://github.com/open-artifacts-ai/open-bus/issues/140)) ([7a940ca](https://github.com/open-artifacts-ai/open-bus/commit/7a940caeb8ebf55e69f5044605341a56648f5884))

## [0.23.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.23.0...v0.23.1) (2026-10-24)


### Bug Fixes

* **dashboard:** final-review security and behaviour fixes ([#135](https://github.com/open-artifacts-ai/open-bus/issues/135)) ([74a5d92](https://github.com/open-artifacts-ai/open-bus/commit/74a5d921b35266fcc9f20a99dd30bb63922f27ad))

## [0.23.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.22.2...v0.23.0) (2026-10-23)


### Features

* **cli:** install openbus into claude, opencode and pi (C8a) ([#133](https://github.com/open-artifacts-ai/open-bus/issues/133)) ([13df821](https://github.com/open-artifacts-ai/open-bus/commit/13df821e8623413762492c50e07fa8f617bcd27f))
* **daemon:** quote the message in expired and refused notices ([#132](https://github.com/open-artifacts-ai/open-bus/issues/132)) ([c1ca8ba](https://github.com/open-artifacts-ai/open-bus/commit/c1ca8ba78ab814177f0ae833426d4ab6320c8b48))
* **hub:** B7 expiry alarm, ack timeout, reconnect flush ([#131](https://github.com/open-artifacts-ai/open-bus/issues/131)) ([7363335](https://github.com/open-artifacts-ai/open-bus/commit/736333516c43648b338f54f9df22aaa4399dfd66))

## [0.22.2](https://github.com/open-artifacts-ai/open-bus/compare/v0.22.1...v0.22.2) (2026-10-23)


### Bug Fixes

* **ci:** recover a stalled apt, retry from archive.ubuntu.com, cache WebKit's debs ([#129](https://github.com/open-artifacts-ai/open-bus/issues/129)) ([1874571](https://github.com/open-artifacts-ai/open-bus/commit/1874571b6ba75f144bf19b2d6d02c665045f6e98))

## [0.22.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.22.0...v0.22.1) (2026-10-23)


### Bug Fixes

* **ci:** bound the Playwright install so a stalled apt mirror can't hang e2e ([#123](https://github.com/open-artifacts-ai/open-bus/issues/123)) ([cf09f17](https://github.com/open-artifacts-ai/open-bus/commit/cf09f178a90617c2ea0505d71d72c4482df9077a))
* **shared:** reject non-well-formed Unicode in frames; @ob/shared/web subpath ([#121](https://github.com/open-artifacts-ai/open-bus/issues/121)) ([d969637](https://github.com/open-artifacts-ai/open-bus/commit/d969637208b64553c77f70f01dc22d0b1df30f7f))

## [0.22.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.21.1...v0.22.0) (2026-10-23)


### Features

* **adapters:** add the pi extension and its liveness gate (C7) ([#120](https://github.com/open-artifacts-ai/open-bus/issues/120)) ([8b5439b](https://github.com/open-artifacts-ai/open-bus/commit/8b5439b93656e4065c065c0f659f420c8d3bbb11))
* **hub:** send, inline delivery, notice, ack, refuse and receipts ([#118](https://github.com/open-artifacts-ai/open-bus/issues/118)) ([f23286c](https://github.com/open-artifacts-ai/open-bus/commit/f23286cb6f921cdb0ea8aaee9b52c97bc22c853d))


### Bug Fixes

* **daemon:** never prompt an opencode session twice after a timeout (C6b) ([#117](https://github.com/open-artifacts-ai/open-bus/issues/117)) ([d6cbb22](https://github.com/open-artifacts-ai/open-bus/commit/d6cbb221e3328bcb63054317299e52a00d164ad4))

## [0.21.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.21.0...v0.21.1) (2026-10-23)


### Bug Fixes

* **ci:** poll staging /healthz until the deployed version is served ([#112](https://github.com/open-artifacts-ai/open-bus/issues/112)) ([6f9d08f](https://github.com/open-artifacts-ai/open-bus/commit/6f9d08f0a12eb6678c4187d30d0189c4c11db7dd))

## [0.21.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.20.0...v0.21.0) (2026-10-23)


### Features

* **hub:** daemon sockets, hello, agent registration and roster ([#110](https://github.com/open-artifacts-ai/open-bus/issues/110)) ([2384b20](https://github.com/open-artifacts-ai/open-bus/commit/2384b203fc567e144260e8d0c55d05ff4c4807f2))

## [0.20.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.19.1...v0.20.0) (2026-10-23)


### Features

* **adapters:** deliver to opencode sessions only while a tui has them (C6) ([#108](https://github.com/open-artifacts-ai/open-bus/issues/108)) ([8c6a4c8](https://github.com/open-artifacts-ai/open-bus/commit/8c6a4c82771cbaa0335e3b0ec1300971170d6b1b))

## [0.19.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.19.0...v0.19.1) (2026-10-23)


### Bug Fixes

* **daemon:** route every claude reply by the sender's namespace ([#101](https://github.com/open-artifacts-ai/open-bus/issues/101)) ([e45dd78](https://github.com/open-artifacts-ai/open-bus/commit/e45dd78bcd99efb06f93a43449a4c5a05fc0a910))

## [0.19.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.18.0...v0.19.0) (2026-10-23)


### Features

* **dashboard:** match the D5 agents handoff (FE7b) ([#98](https://github.com/open-artifacts-ai/open-bus/issues/98)) ([ae25307](https://github.com/open-artifacts-ai/open-bus/commit/ae25307c2bea9d539eccc4e079944207d81bd7da))

## [0.18.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.17.0...v0.18.0) (2026-10-23)


### Features

* **daemon:** adopt shared F2.4 and tell senders about expired mail (C4c) ([#96](https://github.com/open-artifacts-ai/open-bus/issues/96)) ([3df8eb5](https://github.com/open-artifacts-ai/open-bus/commit/3df8eb56d89ac0c5d39832ecb3a0b4d2fffe8f6f))

## [0.17.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.16.0...v0.17.0) (2026-10-23)


### Features

* **hub:** Durable Object schema, stub and machines ([#93](https://github.com/open-artifacts-ai/open-bus/issues/93)) ([c8dc9e3](https://github.com/open-artifacts-ai/open-bus/commit/c8dc9e3ecd9ae6fb67611a4bf60238e7b8635d06))
* **shared:** reserve the openbus bus name; IPv6 loopback; to_namespace to globals ([#94](https://github.com/open-artifacts-ai/open-bus/issues/94)) ([919d0e4](https://github.com/open-artifacts-ai/open-bus/commit/919d0e44ef42e9eae84e9de721cd83b170163f14))

## [0.16.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.15.0...v0.16.0) (2026-10-23)


### Features

* **dashboard:** show machine Live/Offline from connected (FE6c) ([#91](https://github.com/open-artifacts-ai/open-bus/issues/91)) ([c19b3e1](https://github.com/open-artifacts-ai/open-bus/commit/c19b3e1b8401caed8715568878228ad60468c7ca))

## [0.15.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.14.0...v0.15.0) (2026-10-23)


### Features

* **dashboard:** match the D4 machines handoff (FE6b) ([#89](https://github.com/open-artifacts-ai/open-bus/issues/89)) ([daea151](https://github.com/open-artifacts-ai/open-bus/commit/daea1510a9540944ef458766580e3e510f03778d))

## [0.14.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.13.0...v0.14.0) (2026-10-23)


### Features

* **adapters:** deliver to claude over its own uds socket (C5) ([#87](https://github.com/open-artifacts-ai/open-bus/issues/87)) ([c938bfc](https://github.com/open-artifacts-ai/open-bus/commit/c938bfce44de74ec0b7e5de68bce87732543c167))

## [0.13.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.12.0...v0.13.0) (2026-10-23)


### Features

* **shared:** send.to_namespace, the ambiguous refusal and machine connected ([#85](https://github.com/open-artifacts-ai/open-bus/issues/85)) ([4c956b5](https://github.com/open-artifacts-ai/open-bus/commit/4c956b514731a33212cef12aaf97668a619b49b7))

## [0.12.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.11.0...v0.12.0) (2026-10-23)


### Features

* **shared:** MSW mocks and fixtures for the dashboard ([#76](https://github.com/open-artifacts-ai/open-bus/issues/76)) ([5e94dd6](https://github.com/open-artifacts-ai/open-bus/commit/5e94dd6b23e989aab4fa813cb257a743b8410373))


### Bug Fixes

* **ui:** theme dialog, alert-dialog and sheet overlays with --ob-scrim (D2c) ([#80](https://github.com/open-artifacts-ai/open-bus/issues/80)) ([0e37f8b](https://github.com/open-artifacts-ai/open-bus/commit/0e37f8b9b9f1f5914e163ff3d77d173542cc8028))

## [0.11.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.10.0...v0.11.0) (2026-10-23)


### Features

* **shared:** REST routes, DTOs, device flow and SSE events ([#70](https://github.com/open-artifacts-ai/open-bus/issues/70)) ([138474f](https://github.com/open-artifacts-ai/open-bus/commit/138474f1ea1a6f4ef8b30febb2cab5837f73fb3f))

## [0.10.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.9.2...v0.10.0) (2026-10-23)


### Features

* **dashboard:** live agents and namespaces view (FE7) ([#66](https://github.com/open-artifacts-ai/open-bus/issues/66)) ([2f07e55](https://github.com/open-artifacts-ai/open-bus/commit/2f07e55b6e6c1b7fa9da0d348d8d2fa8a898186b))

## [0.9.2](https://github.com/open-artifacts-ai/open-bus/compare/v0.9.1...v0.9.2) (2026-10-23)


### Bug Fixes

* **setup:** one setup token covers the zone and DNS reads (I3b) ([#65](https://github.com/open-artifacts-ai/open-bus/issues/65)) ([74d68c5](https://github.com/open-artifacts-ai/open-bus/commit/74d68c5e1300058252e6e863cda31f8686d0b624))

## [0.9.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.9.0...v0.9.1) (2026-10-23)


### Bug Fixes

* **setup:** recognise wrangler 4's missing-Worker message ([#62](https://github.com/open-artifacts-ai/open-bus/issues/62)) ([aa091ab](https://github.com/open-artifacts-ai/open-bus/commit/aa091ab798191dcd67530f6ecb36c0377ec7be0b))

## [0.9.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.8.0...v0.9.0) (2026-10-23)


### Features

* **dashboard:** machines page with revoke (FE6) ([#57](https://github.com/open-artifacts-ai/open-bus/issues/57)) ([feb69aa](https://github.com/open-artifacts-ai/open-bus/commit/feb69aadf28af1c09c66924cd4c92385f54bc978))
* **server:** Hono shell, fail-closed route gate and /healthz ([#58](https://github.com/open-artifacts-ai/open-bus/issues/58)) ([f05de32](https://github.com/open-artifacts-ai/open-bus/commit/f05de325f4bbbd5f215c74cc6e7b52403562c7c7))
* **setup:** secrets, deploy, selftest and destroy (I3) ([#60](https://github.com/open-artifacts-ai/open-bus/issues/60)) ([460f9e3](https://github.com/open-artifacts-ai/open-bus/commit/460f9e38086987876a3aa9ed1395118bfa744722))

## [0.8.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.7.1...v0.8.0) (2026-10-23)


### Features

* **daemon:** attest adapter identity and route local frames (C4) ([#52](https://github.com/open-artifacts-ai/open-bus/issues/52)) ([ffe45c7](https://github.com/open-artifacts-ai/open-bus/commit/ffe45c70513c59b22358be6f8bbec3e1082efe31))

## [0.7.1](https://github.com/open-artifacts-ai/open-bus/compare/v0.7.0...v0.7.1) (2026-10-23)


### Bug Fixes

* **shared:** idempotent namespace slugs ([#50](https://github.com/open-artifacts-ai/open-bus/issues/50)) ([faed2d6](https://github.com/open-artifacts-ai/open-bus/commit/faed2d6ecfac64a352ca47c97e062733e37ee93e))

## [0.7.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.6.0...v0.7.0) (2026-10-23)


### Features

* **setup:** Access SaaS app and token flow (I2) ([#47](https://github.com/open-artifacts-ai/open-bus/issues/47)) ([bd883a7](https://github.com/open-artifacts-ai/open-bus/commit/bd883a7abfcad717a4ec28197190360864b7af2a))

## [0.6.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.5.0...v0.6.0) (2026-10-23)


### Features

* **shared:** receipts and the daemon-hub wire frames ([#44](https://github.com/open-artifacts-ai/open-bus/issues/44)) ([48dba89](https://github.com/open-artifacts-ai/open-bus/commit/48dba89f15fec8b0089a62b97e63505208c84340))

## [0.5.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.4.0...v0.5.0) (2026-10-23)


### Features

* **daemon:** add the hub websocket transport with reconnect and dedupe (C3) ([#41](https://github.com/open-artifacts-ai/open-bus/issues/41)) ([6e2a275](https://github.com/open-artifacts-ai/open-bus/commit/6e2a2758d14dd120896344134a77e6cf6c56096e))

## [0.4.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.3.0...v0.4.0) (2026-10-23)


### Features

* **dashboard:** browser mocks for dev and e2e (FE4) ([#39](https://github.com/open-artifacts-ai/open-bus/issues/39)) ([8abd248](https://github.com/open-artifacts-ai/open-bus/commit/8abd2489e7d03da83ad69975eb9db81a3201d030))
* **setup:** step runner and prereqs (I1) ([#34](https://github.com/open-artifacts-ai/open-bus/issues/34)) ([f482fd4](https://github.com/open-artifacts-ai/open-bus/commit/f482fd44789cabe26e08fd63b45aefd3b95a33b1))

## [0.3.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.2.0...v0.3.0) (2026-10-23)


### Features

* **ui:** shadcn components themed with the --ob- tokens (D2b) ([#36](https://github.com/open-artifacts-ai/open-bus/issues/36)) ([d3167fc](https://github.com/open-artifacts-ai/open-bus/commit/d3167fc49761ab3c0f173a2b10ab43dc1a77e06e))

## [0.2.0](https://github.com/open-artifacts-ai/open-bus/compare/v0.1.0...v0.2.0) (2026-10-23)


### Features

* **dashboard:** live bus events stream (FE3) ([#30](https://github.com/open-artifacts-ai/open-bus/issues/30)) ([0f54423](https://github.com/open-artifacts-ai/open-bus/commit/0f5442374f04638d72e73b98167286c11d5ed4c8))

## 0.1.0 (2026-10-23)


### Features

* **daemon:** add the local adapter-daemon socket contract (C1b) ([#26](https://github.com/open-artifacts-ai/open-bus/issues/26)) ([465a0fe](https://github.com/open-artifacts-ai/open-bus/commit/465a0feaecdf54463da984dedfba6a73a805c831))
* **dashboard:** API contract, client and query keys (FE1) ([#19](https://github.com/open-artifacts-ai/open-bus/issues/19)) ([57a2342](https://github.com/open-artifacts-ai/open-bus/commit/57a2342c63101bc878d1db3dec4a604480764e76))
* **dashboard:** queries with optimistic, idempotent revoke (FE2) ([#23](https://github.com/open-artifacts-ai/open-bus/issues/23)) ([5242547](https://github.com/open-artifacts-ai/open-bus/commit/52425474a3c41f2db30af32c720b28bef6a5982c))
* **shared:** bus names, namespace normalization and .openbus.json ([#25](https://github.com/open-artifacts-ai/open-bus/issues/25)) ([f0bb215](https://github.com/open-artifacts-ai/open-bus/commit/f0bb215fb1104f350a608639988d168393d6cbaf))
* **shared:** ids, machine tokens, user codes and pinned limits ([#15](https://github.com/open-artifacts-ai/open-bus/issues/15)) ([72fe8f4](https://github.com/open-artifacts-ai/open-bus/commit/72fe8f4a7d5bd85e9b75ec972d82940e4eebcd15))
* **ui:** design tokens (D2) ([#17](https://github.com/open-artifacts-ai/open-bus/issues/17)) ([b6f2119](https://github.com/open-artifacts-ai/open-bus/commit/b6f2119de0353e8fb1c9db7e4edb1e91f6d2cf8f))


### Bug Fixes

* **ui:** make the D1 files pass biome (D1) ([#12](https://github.com/open-artifacts-ai/open-bus/issues/12)) ([4c0db47](https://github.com/open-artifacts-ai/open-bus/commit/4c0db47d73874b0c5098d0124de9d3bccf50594d))

## 0.0.0 (bootstrap)

The scaffold. release-please prepends the real releases above this heading.
