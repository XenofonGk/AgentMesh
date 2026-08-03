# Deferred: Hosted Tier

> **STATUS: OUT OF SCOPE. Do not build toward this.**
>
> AgentMesh is self-hosted open source (PLAN.md D1 = A). This document is a **decision record**,
> kept so the reasoning isn't lost and so the question doesn't have to be re-researched if it
> ever comes up again.
>
> The one thing carried forward into the actual plan: the `SandboxProvider` interface (§6), so a
> stronger isolation backend stays contributable without a refactor. Everything else here —
> billing, key custody tradeoffs, provider ToS for proxying, microVM infrastructure — is
> deliberately not being built.

---

## 1. SaaS is viable — but it's a business, not a project

There is clear prior art. <cite index="21-2,21-3">OpenRouter supports bringing your own provider keys, encrypting them and using them for all requests routed through the specified provider</cite>, and <cite index="21-4">charges a percentage of what the same model would cost normally, waived for a number of BYOK requests per month</cite>. Requesty, Kilo, and Portkey all run variants of the same model. So the pattern is proven and monetizable.

What changes when you host it:

| | Self-host | SaaS |
|---|---|---|
| Key breach | User's own machine | **Your liability, all users at once** |
| Compute cost | User's | **Yours** |
| Legal | None | Entity, ToS, privacy policy, EU DPA, incident response |
| Uptime | User's problem | Yours, at 3am |
| Abuse | N/A | Crypto miners, spam, exfil attempts from day one |

None of this is a reason not to do it. It *is* a reason to sequence it correctly (§5).

---

## 2. Key custody — pick one, and say which on the pricing page

### Option A — Server-held encrypted (the OpenRouter model)
Keys encrypted at rest, decrypted server-side per request.
- ✅ Background/scheduled runs work; user doesn't need to be present
- ✅ Simplest UX
- ❌ You are a credential custodian. A breach is a mass credential incident.
- ❌ Requires a real security posture: audits, incident response, probably insurance

### Option B — Client-held / zero-knowledge (the Warp model)
<cite index="18-1">Warp stores model API keys only on the user's device, in the OS keychain or equivalent, never on Warp's servers.</cite> Browser equivalent: encrypt with a user passphrase, store ciphertext you can't decrypt, decrypt in the browser and pass to a session-scoped proxy.
- ✅ A breach of your DB yields ciphertext you have no key for
- ✅ Dramatically smaller legal and reputational exposure
- ❌ **No background runs** — the key only exists while the user has a tab open
- ❌ Lost passphrase = re-enter keys

### Option C ✅ — Hybrid, zero-knowledge by default
Default to B. Offer A as an explicit, clearly-labeled opt-in for users who want scheduled or background runs. Show them exactly what they're trading.

> *Recommendation: C.* It's honest, it's a genuine differentiator against competitors who
> silently hold keys, and "we cannot read your keys, here's the code that proves it" is a
> strong open-source marketing position. Ship B first; A is Phase 8.

---

## 3. Sandboxing — this is where SaaS breaks the original plan

**Docker per run (PLAN.md D4-B) is no longer sufficient.** The consensus is explicit: <cite index="28-1">the minimum acceptable isolation for a production agent execution sandbox is typically a Firecracker or Kata microVM, and standard Docker/runc shares the host kernel and is explicitly insufficient for untrusted agent code execution</cite>. The decision rule is simple — <cite index="30-1">if a compromise could affect other users' data on the same host, you need a microVM</cite>. In multi-tenant SaaS, it could.

### Do not build this yourself

<cite index="27-1">Firecracker runs each microVM with its own Linux kernel inside KVM, so an attacker must escape both the guest kernel and the hypervisor</cite> — real hardware-level isolation, and real operational complexity: kernel images, snapshot pools, networking, orchestration.

Rent it instead:

| Provider | Isolation | Notes |
|---|---|---|
| **E2B** ✅ | Firecracker microVM | Purpose-built for untrusted LLM code. <cite index="28-2">~150ms init via pre-warmed snapshot pools.</cite> <cite index="29-1">Open-source core, so you can self-host later.</cite> |
| Daytona | microVM | Built for persistent dev workspaces rather than ephemeral runs |
| Modal | gVisor | Broader compute platform; good if you later need GPU |
| Northflank | Kata / gVisor | <cite index="27-2">Handles the microVM operational complexity for you</cite>; BYOC options |

> *Recommendation: E2B.* Open-source core means no lock-in — self-hosters can run Docker
> locally, your hosted tier uses E2B, and the same adapter code targets both. **Buy the
> isolation boundary, build the orchestration.** This removes the single most dangerous
> engineering task from your critical path.

Note E2B's limits before designing around it: <cite index="29-2">session length caps between 1 and 24 hours depending on plan, and paused sandboxes are deleted after 30 days</cite>.

---

## 4. The economics nobody mentions

**With BYOK, the user pays for tokens — you pay for compute.** Sandbox providers bill per
second the sandbox is running. A long agent run costs you real money and earns you nothing
unless you charge for it.

Revenue options:
- **Per-seat subscription** — simplest, predictable, doesn't punish heavy users
- **Compute credits** — bill sandbox-seconds with margin. Honest, aligns cost with revenue.
- **BYOK surcharge** — OpenRouter's model: a small % of what the tokens would have cost
- **Open-core ✅** — self-host free forever; hosted tier paid. Standard for dev tools and the
  only one that gets you contributors.

> *Recommendation: open-core + compute credits.* Free tier with a hard monthly sandbox-second
> cap. Set a per-run wall-clock timeout and a per-user daily budget on day one — not after the
> first surprise bill.

---

## 5. Legal and provider-ToS homework (do this before writing code)

**Provider terms are not uniform and some restrict exactly what you're building.**

- <cite index="18-2">OpenAI and Anthropic do not currently allow consumer subscription plans to be used in third-party clients — users must add an API key and pay the provider directly.</cite> Your onboarding must say this clearly or you'll drown in "why won't my Claude Pro sub work" tickets.
- <cite index="23-1">Google's Antigravity ToS §6 has been read as prohibiting third-party applications from connecting via OAuth</cite> — worth a direct read for any provider you support.
- Read each provider's ToS specifically for: third-party key proxying, resale/repackaging of API access, and attribution requirements.

Also required before launch: legal entity, Terms of Service, privacy policy, a DPA if you'll have
EU users, a documented incident-response plan, and `SECURITY.md` with a disclosure address.

---

## 6. Revised sequencing — self-host first is still correct

**Self-host is not the alternative to SaaS. It's Phase 0 of the SaaS.**

```
Phases 0–6  (PLAN.md)   Self-hostable OSS. Docker sandbox. Zero infra cost to you.
                        → contributors, real users, free security review, validation
Phase 7                 Swap sandbox layer: E2B adapter alongside Docker
Phase 8                 Hosted tier: accounts, billing, quotas, zero-knowledge vault
Phase 9                 Opt-in server-held keys for background runs
```

Why not build SaaS directly:
1. You pay for infrastructure before knowing anyone wants it.
2. You take on custody and legal exposure before the code has been reviewed by anyone but you.
3. Open-source-first is how tools in this category actually get adopted — the free self-host
   tier is your marketing, and the hosted tier converts the subset who don't want to run it.
4. Every hour of Phases 0–6 counts toward the SaaS. Nothing is thrown away.

The only change to make *now*, in Phase 2: put the sandbox behind an interface
(`SandboxProvider`) with a Docker implementation, so adding E2B in Phase 7 is a new file rather
than a refactor.

```ts
interface SandboxProvider {
  create(spec: RunSpec): Promise<Sandbox>;   // docker | e2b | modal
  exec(id: string, cmd: string): AsyncIterable<Output>;
  destroy(id: string): Promise<void>;
}
```
