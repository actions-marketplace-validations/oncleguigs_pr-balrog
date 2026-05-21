# PR Balrog 🔥

> *You shall not merge.*

PR Balrog forces developers to prove they understand their own pull request before they can merge. An AI generates a quiz based on the actual diff — testing the **why** and the trade-offs, not just the what.

As long as the author can't pass the quiz, the merge button stays locked.

---

## How it works

```
PR opened
    │
    ▼
Balrog generates N questions from your diff via AI
Posts quiz as a PR comment
Sets "PR Balrog" check → pending (merge blocked)
    │
    ▼
Author replies: !balrog 1:B 2:A,C 3:B
    │
    ├─ score ≥ threshold  →  check passes  →  merge unlocked ✅
    └─ score < threshold  →  attempts left?
            ├─ yes  →  try again
            └─ no   →  type !balrog retry to get a fresh quiz
```

No external server. Pure GitHub Actions + GitHub Checks API.

---

## Setup

### 1. Add the workflows

Create `.github/workflows/quiz-generate.yml`:

```yaml
name: PR Balrog — Generate Quiz

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to regenerate quiz for (used by !balrog retry)'
        required: true
        type: number

permissions:
  checks: write
  pull-requests: write
  contents: read
  models: read

jobs:
  generate-quiz:
    name: Generate PR Quiz
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false

    steps:
      - name: Generate quiz
        uses: oncleguigs/pr-balrog@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-provider: github-models        # or: anthropic / openai
          # api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          pass-threshold: '80'
          max-attempts: '3'
          quiz-size: 'auto'
          min-lines-threshold: '10'
          language: 'auto'
          pr-number-override: ${{ github.event.inputs.pr_number || '' }}
```

Create `.github/workflows/quiz-evaluate.yml`:

```yaml
name: PR Balrog — Evaluate Answers

on:
  issue_comment:
    types: [created]

permissions:
  checks: write
  pull-requests: write
  contents: read
  actions: write

jobs:
  evaluate-quiz:
    name: Evaluate Quiz Answers
    runs-on: ubuntu-latest
    if: startsWith(github.event.comment.body, '!balrog')

    steps:
      - name: Evaluate answers
        uses: oncleguigs/pr-balrog/evaluate@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          language: 'auto'
          # quiz-responder: 'author'   # author | reviewer | collaborator | any
```

The built `dist/` is committed — no build step needed.

### 2. Configure your AI provider

**Option A — GitHub Models (free for Copilot orgs, zero config)**
```yaml
ai-provider: github-models
# No extra secret needed — uses GITHUB_TOKEN
```

**Option B — Anthropic Claude**
```yaml
ai-provider: anthropic
api-key: ${{ secrets.ANTHROPIC_API_KEY }}
# model: claude-opus-4-7   # optional override
```

**Option C — OpenAI**
```yaml
ai-provider: openai
api-key: ${{ secrets.OPENAI_API_KEY }}
# model: gpt-4o
```

### 3. Enable the merge gate

In your repo: **Settings → Branches → Add protection rule**

```
Branch name pattern: main

✅ Require status checks to pass before merging
  ✅ Require branches to be up to date
  Status checks required: [PR Balrog]   ← exact name

✅ Do not allow bypassing the above settings
```

That's it. The merge button is now locked until the quiz is passed.

---

## Quiz format

Questions are posted as a PR comment:

```
## 🔥 PR Balrog — 5 questions before merge

> **You shall not pass** — prove you understand your own changes.

| Threshold | Attempts | Questions |
|:---:|:---:|:---:|
| **80%** | **3** | **5** |

**How to answer:** Reply with `!balrog 1:A 2:A 3:A 4:A 5:A` — separate multiple answers with a comma.

---

**Q1.** Why was the connection pool size increased from 10 to 50?

- **A)** To reduce memory usage
- **B)** To handle higher concurrent load from the new /stream endpoint
- **C)** It was an arbitrary default value

**Q2.** *(multiple answers)* What risks does removing the mutex in cache.go introduce?

- **A)** Race condition on concurrent writes
- **B)** Deadlock during initialization
- **C)** Silent data truncation
```

The author replies in the PR comment thread:

```
!balrog 1:B 2:A,C 3:A 4:B 5:C
```

Balrog then posts the result:

```
## ✅ Quiz passed — you may merge!

`████████░░` 80% — 4/5 correct

---

✅ **1.** Why was the connection pool size increased from 10 to 50?
✅ **2.** What risks does removing the mutex in cache.go introduce?
❌ **3.** Why was the retry delay set to 500ms?
> ↳ You answered A
> 💡 500ms matches the p99 latency of the downstream service, giving it time to recover before the next attempt.
```

---

## Commands

| Command | Who | Description |
|---|---|---|
| `!balrog 1:A 2:B,C 3:A` | Allowed responder (see `quiz-responder`) | Submit answers |
| `!balrog retry` | Allowed responder (see `quiz-responder`) | Request a fresh quiz (only when attempts are exhausted) |
| `!balrog retry --force` | Repo admins | Force-reset the quiz regardless of remaining attempts |

---

## Configuration

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | GitHub token |
| `ai-provider` | `github-models` | `anthropic` \| `openai` \| `github-models` \| `azure-openai` \| `ollama` |
| `api-key` | — | API key (not needed for `github-models`) |
| `model` | provider default | Override the AI model |
| `pass-threshold` | `80` | Minimum score % to pass |
| `max-attempts` | `3` | Max answer attempts (0 = unlimited) |
| `quiz-size` | `auto` | `3` \| `5` \| `10` \| `auto` |
| `min-lines-threshold` | `10` | Skip quiz if fewer lines changed |
| `exclude-patterns` | `*.lock,...` | Comma-separated globs to exclude from diff |
| `language` | `auto` | `auto` \| `en` \| `fr` \| `es` \| ... |
| `additional-prompt` | — | Extra instructions appended to the AI prompt |
| `quiz-responder` | `author` | Who can answer the quiz: `author` \| `reviewer` \| `collaborator` \| `any` |

### Quiz size (auto mode)

| Changed lines | Questions |
|---|---|
| < 100 | 3 |
| 100 – 500 | 5 |
| > 500 | 10 |

---

## Architecture

```
src/
├── types.ts          # Zod schemas + TypeScript types
├── quiz.ts           # Core logic: size pick, evaluate, render, parse
├── github.ts         # GitHub API: checks, comments, artifacts
├── generate.ts       # Entrypoint: PR opened → quiz created → check pending
├── evaluate.ts       # Entrypoint: comment posted → answers evaluated → check updated
└── providers/
    ├── prompt.ts     # Shared AI prompt
    ├── anthropic.ts  # Anthropic Claude adapter
    ├── openai.ts     # OpenAI + GitHub Models + Azure OpenAI adapters
    ├── ollama.ts     # Ollama (self-hosted) adapter
    └── index.ts      # Provider factory
```

**Why artifacts for answer storage?**  
Correct answers are stored as a GitHub Actions Artifact (1-day TTL) rather than in the PR comment HTML. This prevents the author from inspecting the comment source to find the answers.

---

## Development

```bash
npm install
npm run typecheck   # TypeScript check
npm test            # Jest tests
npm run build:all   # Bundle with ncc → dist/
```

---

## Roadmap

- [ ] Org-level config via `.github/balrog.yml`
- [ ] Metrics comment (team pass rate, average score)
- [ ] GitHub App mode (no workflow files needed in target repos)
- [ ] Publish to GitHub Marketplace
