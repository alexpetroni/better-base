# Running the build with claude-phase-runner

The plan is designed for `~/work/claude-phase-runner`: `PROMPT.md` is the entry
file, `docs/phases/PHASE-*-PLAN.md` are the phase files, one agent run each.

## Setup

```bash
cd ~/work/claude-phase-runner
cp credentials.env.example credentials.env   # add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
cp runner.env.example runner.env             # then replace its contents with:
```

```bash
PROJECT_DIR=/home/alex/work/better-base
ENTRY_FILE=PROMPT.md
PHASE_FILES="docs/phases/PHASE-0-PLAN.md docs/phases/PHASE-1-PLAN.md docs/phases/PHASE-2-PLAN.md docs/phases/PHASE-3-PLAN.md docs/phases/PHASE-4-PLAN.md docs/phases/PHASE-5-PLAN.md docs/phases/PHASE-6-PLAN.md docs/phases/PHASE-7-PLAN.md"
RETRY_SCHEDULE="30 300 3600 10800"
# Phase 0 installs the workspace and Phase 2 pulls MinIO/imgproxy images —
# both are single silent tool calls; keep the stall timeout generous.
STALL_TIMEOUT=2400
# Independent gate — matches the scripts Phase 0 must create.
GATE_CMD="pnpm lint && pnpm check && pnpm test:unit"
# No remote yet: keep PUSH=0 until you add one, then set PUSH=1.
PUSH=0
GIT_REMOTE=origin
GIT_BRANCH=
```

## Run

```bash
DRY_RUN=1 bash run.sh   # always first: prints the composed Phase 0 prompt
bash run.sh             # inside tmux — phases take hours
```

Monitor: `tail -f state/logs/phase-*.log | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text'`

## Notes

- **Gate caveat**: `GATE_CMD` runs before Phase 0 has created those scripts only
  in the sense that it runs AFTER each phase — Phase 0's first deliverable is
  exactly these scripts, so the gate is valid from the first phase boundary.
- Phases 2+ integration/e2e tests need the compose stack; the agent manages
  `docker compose up` itself (DooD — services are reachable for it at
  `host.docker.internal`, as instructed in PROMPT.md).
- If a phase aborts with `BLOCKER.md` in the repo root, read it, decide, delete
  it, and re-run — the runner resumes at the unfinished phase.
- To re-run a finished phase intentionally, remove its line from
  `claude-phase-runner/state/phases-done`.
