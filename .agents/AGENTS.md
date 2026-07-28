# CONNECT-Mypreneur Workspace Rules

## Git Commit & Deployment Approval Gate

**CRITICAL RULE — No exceptions:**

Before executing ANY of the following commands, you MUST stop and explicitly ask the user for approval:

- `git commit`
- `git push`
- `git merge`
- `git rebase`
- `git tag`
- Any deployment command (e.g., `npm run deploy`, `deploy.js`, `deploy.sh`, `pm2`, `ecosystem.config.js`)

### Required Approval Format

When asking for approval, clearly state:
1. **What** you are about to commit/push/deploy
2. **Which branch** is the target
3. **A summary of changes** included

Do NOT proceed until the user explicitly says "yes", "approve", "go ahead", or equivalent confirmation.

### Example

> **Approval Required Before Commit**
>
> I am about to run `git commit -m "feat: some change"` on branch `main`.
>
> **Changes included:**
> - `src/SomeFile.jsx` - description of change
>
> Do you approve this commit?

Never bypass this rule, even if the user previously asked you to "make changes" or "fix something."
