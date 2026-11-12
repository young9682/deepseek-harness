---
name: dsh-sync-upstream
description: Use when syncing the fork's master with upstream deepseek-ai/deepseek-harness — before or after merging upstream/master into the fork, when a merge produces conflict volume or post-merge test failures out of proportion to the diff, when node_modules breaks after an upstream merge, or whenever a fork commit must be verified as the complete feature delta against upstream. Owns the merge discipline that prevents history pollution and silent file losses.
---

# Syncing the fork with upstream

`origin` is `young9682/deepseek-harness` (the fork); `upstream` is `https://github.com/deepseek-ai/deepseek-harness`. The fork's master carries the Session-delete feature delta (~109 files) on top of a fast-moving upstream (~1000 commits/month). A sync merge follows a fixed discipline: every rule below exists because skipping it already cost a day of debugging.

## Merge rules

1. **Never stash during a merge.** `git stash push` (even `--keep-index`) clears `MERGE_HEAD` and downgrades the merge to a single-parent commit; the resulting fake lineage then produces conflict avalanches (262 conflicts, 18 silently lost files) at the next sync. Set unrelated work aside by committing it first or copying files aside.
2. **Verify every merge by parent count, not message**: `git log --format="%p" -1 <sha>` must show two hashes. A commit message saying "Merge origin/master ..." proves nothing.
3. **Resolve by hunk, never by whole-file checkout, for feature files.** A whole-file `git checkout upstream/master -- <feature file>` deletes feature code that auto-merged cleanly. Take upstream wholesale only for files outside the feature scope.

## Post-resolution steps (all required)

1. **Regenerate derived artifacts** so they reflect the merged sources: `gen-client-catalog`, `gen-cordis-catalog`, `gen-config-catalog`, `gen-persistence-catalog`, `gen-doc-graphs` (scripts run directly through `node_modules/.bin/tsx` or `node node_modules/tsx/dist/cli.mjs`). Generated output decides semantic disputes — for example, which toast keys exist — over stale committed files.
2. **Re-record bilingual pairings** for every changed md pair: `node_modules/.bin/tsx scripts/verify-translation-pairing.ts --write <source.md>`, then check all staged pairs with `--cached` plus the staged `.i18n.yaml` list.
3. **Reinstall node_modules** (`pnpm install --frozen-lockfile --registry=https://registry.npmjs.org`). Upstream merges add workspace packages; the links exist only after install. Skipping this breaks tests with module-not-found (for example a missing `dsh-agent-team` link), and direct `node node_modules/tsx/...` invocations bypass pnpm's verify-deps auto-install. See [pnpm-env-pitfalls] in the agent memory if install hangs.
4. **Audit for silent losses**: `git diff --name-only upstream/master HEAD` must equal exactly the feature scope (Session-delete files, `scripts/build-exe-for-ssh-helper.ts`, `.github/workflows/ci-master.yml`). Any file outside that set is a silent auto-merge loss — take upstream's version for non-feature files. One audit of this kind recovered 18 lost files, including a dropped dependency that broke `--frozen-lockfile` installs.
5. **Re-run the owning test suites**: textually clean auto-merges can still split semantics across files (a real case: `commands.ts` calling the old 3-argument `hasApiSessionSubagentOwner` after upstream moved to 1 argument — no conflict, tests failed with `reading 'origin' of undefined`). Run the backend suites (`session-controller`, `workspace-controller`, `session-persistence(-jsonl)`, `workspace`) and `ui-workspace` locally; run liveshare, snapshots, and doc-sync in the cluster pod.

## Disproving failures that look like regressions

Upstream workflows that have never run on upstream (checked via the API `total_count`, for example the ssh-helper and python suites) can carry latent bugs that only surface on this fork. Disproof technique: clone pristine upstream in the same environment and run the identical spec; an identical failure there means environment, not the merge. One such case cleared `operations-process.spec.ts` ("stops the whole tree of a stalled run"), which fails identically on a pristine upstream clone inside the cluster pod.

## Dev Note

The upstream URL is `https://github.com/deepseek-ai/deepseek-harness` (not the deepseek-harness org; merge-commit trailers name contributor branches only). Linux-only suites and symlink-sensitive tests belong in the cluster pod, not on Windows; see the agent memory `validation-environments` for the pod recipe.
