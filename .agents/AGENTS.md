# CONNECT-Mypreneur Workspace Rules

## Rule 1: Git Commit & Deployment Approval Gate

**CRITICAL RULE — No exceptions:**

Before executing ANY of the following commands, you MUST stop and explicitly ask the user for approval:

- `git commit`
- `git push`
- `git merge`
- `git rebase`
- `git tag`
- Any remote deployment command (e.g., `npm run deploy`, `deploy.js`, `deploy.sh`, `pm2`, `ecosystem.config.js`)

### Required Approval Format

When asking for approval, clearly state:
1. **What** you are about to commit/push/deploy
2. **Which branch** is the target
3. **A summary of changes** included

Do NOT proceed until the user explicitly says "yes", "approve", "go ahead", or equivalent confirmation.

Never bypass this rule, even if the user previously asked you to "make changes" or "fix something."

---

## Rule 2: Local-Only Build & Deploy

**CRITICAL RULE — No exceptions:**

All builds and deployments MUST run on **local environment only**:

- Use **local Node.js** (never deploy to a remote server or cloud)
- Use **local database** (never connect to or modify a production/remote DB)
- Run dev servers locally using `npm run dev` or equivalent
- NEVER run `git commit`, `git push`, or any deployment script as part of a build

### Allowed local commands:
- `npm install`
- `npm run dev`
- `npm run build` (local build only, not for deployment)
- `node server.js` (local only)

### Forbidden without explicit user approval:
- Any command that pushes code to a remote server
- Any command that connects to a production database
- Any deployment pipeline trigger
- Any `git` write command (commit, push, merge, tag)

**When in doubt — stop and ask the user before proceeding.**
