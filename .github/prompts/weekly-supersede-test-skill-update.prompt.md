---
name: "Temporary Superseder Test"
description: "Create a throwaway file change to exercise the weekly skill-update PR superseder."
---

This prompt is only for verifying weekly workflow superseding. Do not edit skills, prompts, workflow files, or documentation.

Ensure `assets/weekly-supersede-test.txt` contains exactly:

```text
supersede probe revision 1
```

Create one pull request for this file change. Use the exact title `weekly-supersede-test-skill-update: supersede probe`. The weekly worker adds the `[skill-update] ` prefix. Keep the PR body concise and identify it as a temporary test that will not be merged.
