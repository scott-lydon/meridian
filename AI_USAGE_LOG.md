# Meridian — AI Usage Log

This document is the audit trail for AI-assisted contributions to Meridian. It is the source of truth a grader can use to answer "what did the AI write, what did the human write, and how do I tell which is which?"

## Headline numbers

- **144** total commits on `main` as of 2026-05-27 (HEAD inclusive of this update).
- **135** carry the `Assisted-by: Claude` trailer — **93.75%** of all commits.
- **0** commits were generated without human review. Every commit was prompted, audited, and approved by the human author (Scott Lydon) before landing.

Verify the trailer count yourself:

```bash
git log --grep="Assisted-by" --oneline | wc -l   # → 135
git log --oneline | wc -l                         # → 144
```

If you read this file at a later HEAD, expect both counts to be higher; the ratio should stay above 90%.

The nine commits without an explicit trailer break down as four pre-trailer-policy bootstrap commits from the very first session (workspace scaffold, license, README placeholder — functionally equivalent to `pnpm create next-app` output, no business logic) and five later commits where the trailer was simply not appended despite the policy. List them yourself:

```bash
git log --oneline --invert-grep --grep="Assisted-by"
```

The five missed-trailer commits are still AI-assisted (they were authored in the same Cowork / Claude Code sessions as the surrounding trailered commits); the trailer was a documentation omission, not a workflow change. All trailered or not, the same human-review gate applied.

## Tools used

| Tool | Used for | Where you see the evidence |
|---|---|---|
| **Claude in Cowork** (Anthropic's desktop research-preview agent) | Architectural discussion, multi-file refactors, doc authoring, the spec-driven artifacts (constitution.md / spec.md / plan.md / tasks.md), this very file | `Assisted-by: Claude` trailer on most commits; conversation handoff at `/Users/scottlydon/Documents/Claude/Projects/Gauntlet/handoff-*.md` |
| **Claude Code** (Anthropic's CLI agent) | Same model surface as Cowork but invoked from the terminal; used for narrow self-contained tasks (running tests, applying a one-file fix that needed shell access) | Same trailer; commit body mentions `claude-code-bridge` or `delegate_to_claude_code` when used that way |
| **qa-adversary sub-agent** (a Claude Code sub-agent at `~/.claude/agents/qa-adversary.md`) | Fresh-context adversarial review of every code change on the assignment | Reports at `tests/qa-adversary-reports/*.md`; the three `FAILING:` regression tests in `tests/qa-adversary.property.test.ts` are pinned bugs the adversary found and wrote red-tests for |

No other AI assistants (Copilot, Cursor, ChatGPT, Gemini) were used for code generation on this project. The constitution non-negotiable around `Assisted-by` trailers makes a Copilot inline-suggestion path practically incompatible with the workflow.

## What the AI did

**Architecture and design.** The four foundational artifacts (`constitution.md`, `spec.md`, `plan.md`, `tasks.md`) were drafted by Claude in Cowork against the PRD that was uploaded at the start of the project, then iterated through several rounds of human-driven critique before being committed. The Mermaid topology, the decision table in `plan.md`, the trade-off panels — all drafted by Claude, all reviewed line-by-line by the human author.

**On-chain program.** The Anchor program under `programs/meridian/` was written by Claude in Cowork in conversation with the human author, slice by slice (`tasks.md` slices 1 through 5). Every slice ran the qa-adversary sub-agent in a fresh context before being declared done. The most recent example, landed on 2026-05-25 in commits `05afb4f` and `aeff964`:

- `refactor(program): extract settlement math into pure helpers` — extracted `decide_outcome`, `pyth_price_to_micros`, `pyth_confidence_bps` from three Anchor instruction handlers into a new `programs/meridian/src/math.rs`. The handlers' behaviour at the validator is byte-for-byte identical; the math is now unit-testable without `solana-test-validator`.
- `test(program): add 67 inline unit and property tests for the on-chain program` — added `#[cfg(test)] mod tests` blocks across `math.rs`, `order_book.rs`, `state.rs`, and `constants.rs`. Property tests via `proptest = { workspace = true }`.

**Frontend.** The Next.js 14 App Router code under `app/` — wallet adapter wiring, the trade page, the order-book WebSocket subscription, the Zustand store with non-allocating selectors — was authored by Claude in Cowork in iterative slices. The "tray pieces hide colors" lesson from a prior Gauntlet project (boxy-fractions) is baked in as a feedback memory and prevented a recurring class of UI regression.

**Automation keeper.** The Node automation service under `automation/` — the morning, settlement, and crank crons, the expiry-sweep gate the qa-adversary flagged on 2026-05-24, the `/health` endpoint — was authored by Claude in Cowork. The `pino` structured-logging pattern was adapted from a prior Gauntlet project (adversary) on the user's request.

**Documentation.** The `README.md`, `ARCHITECTURE.md`, `website/index.html`, `docs/DEFENSE_BREAKOUT_SCRIPT.md`, and `docs/AI_INTERVIEW_PREP.md` were drafted by Claude in Cowork to the user's documented style preferences (no em-dashes in spoken scripts; no forced contrasts; Simple-Icons logos on every Mermaid node; no edge crossings). Each subsequent architecture change updates the website in the same commit per the standing rule.

## What the human did

**Direction and review.** Every commit was prompted and reviewed by the human author. The user's CLAUDE.md preferences (`/Users/scottlydon/Documents/Claude/Projects/Gauntlet/CLAUDE.md` and `~/.claude/CLAUDE.md`) define the rigor calibration: the submit-gate must run on every assignment response with the $10,000-stakes prompt re-asked verbatim; the qa-adversary sub-agent must run in a fresh context on every code change; the spec-driven artifacts are the single source of truth.

**Architecture decisions.** Where Claude offered options, the human author chose. Examples: the choice to use a slab-based in-program order book (instead of CPI-ing into Serum or OpenBook), the choice to ship at devnet only for the submission (mainnet as a documented bonus path), the choice to drop order-book depth from 256 to 64 after Solana's 10240-byte CPI-create-account realloc ceiling was hit, the choice to stamp every PDA seed list with `PROGRAM_VERSION` so a future v2 program can coexist with v1.

**Bug surfacing.** The human author surfaced bugs Claude didn't catch: the cluster-mismatch banner on the trade page (commit `e189e98`), the `Phantom on Safari` detection fallback (`9b9dbe1`), the DEVNET popover scrolling on short screens (`358ec95`). The qa-adversary sub-agent caught most of the rest, but the human author always read the adversary report and decided what to fix vs accept.

**Deployment.** Every Render deploy, every devnet `anchor deploy`, every program-id rotation was the human author's hand on the trigger. The AI was never given credentials.

## Reproducing this audit

```bash
git clone https://github.com/scott-lydon/meridian.git
cd meridian

# How many commits total?
git log --oneline | wc -l

# How many AI-assisted?
git log --grep="Assisted-by" --oneline | wc -l

# Show the trailer on a recent commit:
git log -1 --format='%H%n%n%B' aeff964

# Browse the qa-adversary reports for AI-driven red-teaming:
ls tests/qa-adversary-reports/

# Browse the user's spec-driven artifacts:
ls constitution.md spec.md plan.md tasks.md
```

## Caveat for graders

This log is meant to be transparent, not exhaustive. Specific prompts and turn-by-turn chat transcripts are not retained per Anthropic's product behavior (Claude's chat history lives in the desktop app, not in this repo). What IS retained: the commit graph, the `Assisted-by` trailers, the qa-adversary reports, the foundational artifacts, and the conversation handoff documents under `/Users/scottlydon/Documents/Claude/Projects/Gauntlet/handoff-*.md`.

If a grader wants a single sentence that summarizes the AI contribution: Claude wrote nearly every line of code in this repo under direction from the human author, with the qa-adversary sub-agent serving as a fresh-context auditor on every change. The human author is responsible for every commit that landed, every deploy that shipped, and every architectural decision the code reflects.
