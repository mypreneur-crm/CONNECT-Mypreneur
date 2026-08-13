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

---

## Rule 3: Database Structure Changes Require Approval

**CRITICAL RULE - No exceptions:**

You MUST stop and get explicit user approval before making ANY of the following:

- Adding, removing, or renaming **database tables**
- Adding, removing, or modifying **columns** in any table
- Changing **data types**, constraints, indexes, or foreign keys
- Running any ALTER TABLE, DROP TABLE, CREATE TABLE, or TRUNCATE statements
- Modifying any **Prisma schema** (schema.prisma) or running prisma migrate, prisma db push
- Changing any ORM models or database initialization scripts (e.g., schema.js, lib/schema.js)

### Required Approval Format

Before proceeding, clearly state:
1. **Which table(s)** are affected
2. **What change** is being made (add column / drop column / alter type / etc.)
3. **Why** the change is needed
4. The **exact SQL or migration** you plan to run

Do NOT execute any database structural change until the user explicitly approves with "yes", "approve", "go ahead", or equivalent.

> This rule exists to protect live production data. Even schema changes that appear safe can cause data loss or application downtime.

---

## Rule 4: UI / Frontend Changes Require Prior Approval

**CRITICAL RULE - No exceptions:**

Before making ANY visible changes to the user interface, you MUST stop and present a plan for approval. This includes:

- Changes to **pages, layouts, or navigation** (adding/removing/reordering menu items, routes, or views)
- Changes to **UI components** (buttons, forms, tables, modals, cards)
- Changes to **colors, fonts, spacing, or design tokens** (CSS variables, Tailwind config, theme files)
- Adding or removing **UI libraries or icon sets**
- Changes to **dashboard widgets or data visualizations**
- Any modification to index.html, global CSS files, or root layout components

### Required Approval Format

Before proceeding, clearly state:
1. **Which page or component** is affected
2. **What the change looks like** (describe or show a before/after)
3. **Why** the change is needed

Do NOT make any frontend/UI changes until the user explicitly approves.

> This rule exists because UI changes directly affect end-user experience and branding, and must be intentional and reviewed before implementation.

---

## Rule 5: General Check-in Gate — No Autonomous Code Commits

**CRITICAL RULE - No exceptions:**

You are NEVER allowed to autonomously decide to commit or check in code. Every single code change that goes into version control MUST be explicitly approved by the user.

This means:
- **Do not stage files** (git add) without showing the user what will be staged
- **Do not commit** without user saying "commit" or "approve commit"
- **Do not push** without user saying "push" or "deploy"
- **Do not squash, amend, or rewrite history** without explicit user instruction
- **Do not merge branches** without explicit user instruction

If you have completed a set of changes and believe they are ready, say:

> "Changes are complete. Would you like me to commit and push?"

Then wait for approval. Never assume "fix this bug" or "implement this feature" implies permission to commit the result.


# Deployment Domain Rule
When working on this project, it must ALWAYS deploy or run in the subdomain: connect.mypreneur.co.in
