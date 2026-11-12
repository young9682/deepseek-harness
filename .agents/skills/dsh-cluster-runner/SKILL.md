---
name: dsh-cluster-runner
description: Use when the fork's self-hosted GitHub Actions runner (gh-runner Deployment in the advisor-young86 namespace of the BBT PRD cluster) needs setup, rebuild, registration repair, or debugging — when cluster CI legs fail on the runner, when the runner shows offline or its pod restart loops, when bubblewrap/Playwright/node toolchain errors appear in a CI job, or when CI legs must be routed to or away from the cluster.
---

# Operating the cluster self-hosted GitHub Actions runner

The fork runs one self-hosted runner as a privileged Ubuntu 24.04 pod so the `serial / linux` CI leg (and PR Linux legs via the `DSH_CI_FAILOVER_LINUX=selfhosted` repository variable) executes in the cluster. The complete manifest lives beside this file: [gh-runner.yaml](gh-runner.yaml) with `PLACEHOLDER_PAT` as the token placeholder. Apply it with `sed "s|PLACEHOLDER_PAT|$token|" gh-runner.yaml | kubectl apply -f -`, where `$token` comes from `git credential fill` for github.com.

## The image and its five failure layers

Each layer below failed a real run; the manifest already encodes every fix. Do not remove a fix to simplify.

1. **Base image must be ubuntu:24.04** (GLIBC 2.38). The CI's bubblewrap preparation script downloads an Ubuntu 24.04 bwrap build; Debian bookworm's GLIBC 2.36 cannot execute it.
2. **Phase split**: the runner binary refuses to run as root (`Must not run with sudo`), so phase1 runs as root (apt toolchain, `useradd runner` uid 1001, NOPASSWD sudo, runner tarball, `./bin/installdependencies.sh`, chown) and then drops privileges with `setpriv --reuid=1001 --regid=1001 --init-groups`.
3. **The runner's dotnet needs libicu**: run `./bin/installdependencies.sh` in phase1, and preinstall `libicu-dev apt-transport-https` in the base apt so a stalled installdependencies cannot leave config failing in a restart loop.
4. **The node's container policy blocks bubblewrap's userns proc mount** (RHEL 10 nodes): `seccompProfile: Unconfined` and `seLinuxOptions: spc_t` are both insufficient — the container needs `privileged: true`.
5. **apt through the campus proxy stalls forever** (empty `/var/cache/apt/archives/partial/`, no timeout): export `NO_PROXY` for `archive.ubuntu.com`, `security.ubuntu.com`, `deb.nodesource.com`, set `Acquire::Retries "6"`, and keep the proxy only for GitHub downloads. Distinguish stalled from slow by checking whether the partial directory changes.

## Playwright system dependencies

The workflows install browser binaries only; the comment in ci-master.yml states the persistent VM image owns the Linux system packages. The runner installs them itself in phase1: `npx -y playwright@1.61.1 install-deps chromium webkit` (version matches the repository's web frontend). Without it every browser-dependent Web test fails with `browserType.launch: Target page, context or browser has been closed`.

## Lifecycle and routing

- **Ephemeral registration**: each pod restart re-downloads the runner (~200MB), re-registers with `--pat "$GH_PAT" --ephemeral --replace`, and takes one job. PAT comes from the `gh-runner-pat` Secret (created from `git credential fill`); it must have repo-admin scope.
- **Labels** `self-hosted,linux,X64,vm-backup,ubuntu-latest`: the first four select `serial / linux (self-hosted standby)` on every push to master; `ubuntu-latest` lets hosted-runner jobs also land here.
- **Routing variables** (repository level, set via API): `DSH_CI_FAILOVER_LINUX=selfhosted` routes PR CI Linux legs to the runner; `DSH_CI_SKIP_UNRUNNABLE_LEGS=true` skips the python wheel legs (they need the `DEEPSEEK_API_KEY_EXTERNAL` secret plus macOS/ARM64 hosted runners) and serial-windows (it needs upstream's `dsh-win-ci` machine and queues forever). The guards live in ci-master.yml's python-runtime and serial-windows `if:` lines.
- **Disabled workflows** on the fork (API `PUT /actions/workflows/{id}/disable`): ci-windows.yml, ci-python.yml, e2e.yml — each fails purely on missing credentials.
- **Concurrency**: ci-master.yml uses `cancel-in-progress: true` per ref, so a workflow_dispatch cancels an in-flight push run. Do not dispatch while a push run matters.
- **Variables snapshot**: a repository variable created via API is invisible to a run started seconds later; the next push sees it.
- **Rerun**: `POST /actions/runs/{id}/rerun-failed-jobs` returns 403 while any job is queued (a queued job keeps the run open).

## Repair and cleanup

- Ghost registrations: every pod generation leaves an offline runner entry; delete them with `DELETE /actions/runners/{id}` (they accumulate — six at once has happened).
- The runner's long-poll occasionally times out (100s) through the mirror chain and self-heals with `Runner listener exit with retryable error`; GitHub shows offline briefly. No action needed.
- A mid-job container restart cancels the in-progress job (restartCount increments; ephemeral exits are clean, exit code 0 — not OOM).
- `GITHUB_PATH` must be a FILE when testing scripts like prepare-ci-bubblewrap.sh locally in the pod.
- Rebuild the pod only when needed: a full phase1 cycle costs about 10 minutes (apt through direct routes, runner download through the proxy).

## Dev Note

The campus proxy `10.100.1.111:10810` and the namespace name are BBT-cluster facts; the manifest already carries them. Token rotation only requires updating the `gh-runner-pat` Secret. Cluster access itself needs a fresh Rancher kubeconfig when kubectl returns 403 `system:unauthenticated`.
