---
name: "Build & Deploy Website"
description: "Build the skills catalog website and deploy it to GitHub Pages. Fetches skill metadata from all plugin repos, generates docs/, commits, and pushes."
agent: "agent"
---

Build and deploy the skills catalog website to GitHub Pages.

Steps:

1. Run the build script to regenerate the site:
   ```bash
   node scripts/build-website.mjs
   ```
2. Verify the build succeeded (18 skills across 3 plugins expected).
3. Stage the generated output:
   ```bash
   git add docs/
   ```
4. If there are changes, commit and push:
   ```bash
   git commit -m "chore: rebuild skills catalog website"
   git push origin main
   ```
5. If push is rejected due to remote changes, pull with rebase, rebuild, then push again:
   ```bash
   git pull --rebase origin main
   node scripts/build-website.mjs
   git add docs/
   git rebase --continue
   git push origin main
   ```
6. Confirm the push succeeded. GitHub Pages will deploy automatically from `docs/` on `main`.
