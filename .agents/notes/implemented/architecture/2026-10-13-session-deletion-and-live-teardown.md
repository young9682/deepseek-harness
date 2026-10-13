# Agent Note: Session deletion and live teardown

Status: implemented

English | [中文](2026-10-13-session-deletion-and-live-teardown.zh.md)

## Problem

The harness shipped no way to remove a stored Session. Archiving was the only recovery-shaped operation, and it never touches a file: it appends an id to the durable `archivedSessionIds` set. Both the persistence seam and the sidebar documented that as a limit — "No deletion or retention API" and "No Session deletion" — so a user who wanted a conversation and its log gone had only out-of-band filesystem work, which requires knowing the deployment's storage root and the project-directory encoding.

Adding deletion is not just a `rm`. A Session that is live in the process holds an open persistence write handle, and the backend routes that Session's events by id into it, so removing the files first would simply recreate them on the next event. The client's Session list is the merge of the live registry and the persistence listing, so a Session that stays live keeps its row after its log is gone. And nothing in the API host could make a Session non-live: `create` and `resume` return an `AgentHandle` whose `dispose()` stops the loop, unregisters the agent, and removes the session from the store — but the host discarded it and kept only `.agent`. Opening a conversation's history promotes it to a live agent, so in practice almost every row a user can see is live.

## Decision

**Deletion is a persistence capability, and the seam owns only removal.** `SessionPersistence.delete(id)` removes every artifact the backend owns for one session — the complete stored log (all retained generations), the session directory, and the write-lock file inside it — and nothing else. It is idempotent (an id the backend cannot see resolves, because removal's postcondition already holds) and never touches content-addressed artifacts shared with other sessions: attachments have no session→object reverse index, so a backend cannot know whether deleting one would break another session, and it does not try. Which sessions get removed stays the caller's decision; nothing in the seam ages sessions out and there is no bulk prune.

**An open write handle is refused; a closing one is awaited.** The shipped provider rejects with `SessionPersistenceActiveError` while this instance holds an *open* write handle for the id, because the live write path would recreate the log. A handle that is already closing is awaited instead. That asymmetry is load-bearing: the provider's `session/disposed` listener starts the final drain and calls `handle.close()` *without awaiting it*, so a caller that disposes a Session and deletes immediately would otherwise be turned away by a close still in flight — exactly the sequence the host performs.

**The API host retains each Agent's teardown capability.** `ApiSessionAgentController` keeps the `AgentHandle` returned by `agents.create`/`agents.resume` in a map keyed by session id, and drops each entry when the Agent is disposed (a `agent/disposed` listener prunes handles this controller did not dispose itself). `disposeLive(id)` takes and disposes the handle: stopping the loop, awaiting its exit, unregistering the Agent, removing the Session from the store, and unwinding its scope. That is the only path that makes a Session non-live, so it is the precondition for removing the log rather than an optimization.

**`session.delete` orders the work so the files cannot come back.** The command refuses an archived Session as `session/archived` (archiving is the recoverable state, so the user restores before deleting), refuses a Session owned by subagent routing, and — unless the caller sets `stopActivity` — refuses a Session with running work as `session/active` with the work listed. It then stops running work through the same `workspace/session-stop` event archive admission uses, disposes the live Agent, calls `sessionPersistence.delete`, drops the projection-cache checkpoint, calls `WorkspaceRegistry.forgetSession` to drop the archive entry, pin, accounting slot, and indexed header, and announces the removal to connected clients. A Session that was never live emits no `session/disposed`, so the command announces only in that case; a disposed Session already announced through the existing listener.

**Deletion does not cascade.** Forks and subagent descendants survive their removed parent. The surviving children keep a `parentSession` that names a Session no longer present, which the codebase already tolerates: lineage tracing returns `complete: false` with `unresolvedParentId` instead of throwing, the subagent control surface has a dedicated `subagent/parent-unavailable` code, and parent-catalog discovery already degrades a missing child to unknown mode. Cascading was rejected because a fork is a user-visible conversation in its own right, and deleting one row silently destroying others is a worse failure than a dangling pointer the UI already knows how to render.

**The registry answers archive questions without exposing its set.** `WorkspaceRegistry.isArchived(id)` exists so the deletion command branches on a read method rather than reaching into `archivedSessionIds`, keeping the archive set's one home in the registry. `WorkspaceRegistry.sessionActivity(id)` exposes the same `workspace/session-activity` waterfall archive admission reads, so the client's confirmation dialog can list what confirming would stop — a read, not an admission check, and it installs no state.

**The client always confirms, and never offers a hover button.** Deletion is irreversible, so it stays behind the row's "..." menu, separated below Archive, with no `sidebar.workspaces.session.row.action` entry. Selecting it opens a dialog that states the irreversibility, asks the Host what the Session is running, and lists those families when there are any; its confirm button stops that work and then deletes. An archived row is refused before the dialog opens — the menu entry is still visible, but selecting it raises "unarchive it first" — and the Host refuses identically when a concurrent archive wins the race. Deleting the Session shown in the main view clears the selection so the view returns to its Workspace with nothing selected, rather than opening an unrelated conversation the user did not ask for. A successful deletion raises a notice with no undo action, because there is nothing to undo.

## Deferred

**Disconnecting an abandoned recordless Session from navigation.** A Session created and never prompted carries a provisional row: the browser renders no row verbs on a blank row and hides every blank row that is not selected, so Delete cannot reach one, and each New Session click leaves a stored log nothing can remove. The requirement is that leaving such a Session removes it, while any Session that holds *records* — a message, a tool call, anything the log has seen — is kept.

The signal is records, not the `blank` flag this work first reached for. The Host computes `blank` from the `sessionListMetadata` projection with two different fallbacks: an attached Session falls back to `session.seq === 0`, while a persisted Session that is not live falls back to `false` (`packages/api/session-controller/src/list.ts`, `summaryFor` and its cold sibling). A Session with no records therefore reads blank or not depending on whether it happens to be materialized and metadata-cached. A manual run showed exactly that split: the Session restored from a previous app run was discarded, and the Session created seconds earlier in the same run was kept — with a clean browser console, which rules out both the composer read failing (`conversation.input.for` throwing) and the Host refusing the removal, leaving the predicate itself as the answer. A Session with no events is the fact both the live stream and the stored log agree on, so `seq === 0` is the criterion to build on.

The abandoned-Session check must keep its composer guard regardless: a Session with no records can still hold a draft, a staged attachment, a queued message, or a submission in flight, and those Sessions must be kept — an unselected blank row is hidden and unreachable, so discarding typed work would destroy it with no way back.

Not built. The rows differ in no user-visible way from the deferred case today, so none of this is observable in the shipped product.

## Alternatives considered

**Force-closing the backend's write handle inside `delete`.** The backend's `delete` could invalidate the active handle and remove the files, leaving the caller with nothing else to do. Rejected: it leaves a live, unreachable Agent — `ctx.agents.get(id)` and `ctx.sessions.get(id)` keep answering, `session/disposed` never fires so the projection cache's detach write and the client's row both leak, and the still-registered turn keeps emitting events that route nowhere. The store would contradict the disk, which is exactly the state the harness elsewhere refuses to enter.

**Refusing deletion for any Session live in this process.** The smallest change: no handle retention, no lifecycle work. Rejected as unusable — opening a conversation promotes it to a live agent, so the rows a user most wants gone are precisely the ones this would refuse, and there is no other way to unload them.

**Cascading to forked and subagent descendants.** Rejected above: it turns one confirmation into the silent destruction of conversations the user can see.

**Rendering the row verbs on blank rows so Delete reaches them, instead of disconnecting on navigation.** The slot contract already lets an entry render nothing when its action does not apply, so the four shipped actions could each opt out and leave Delete alone on the menu. Rejected for the deferred work: it puts a single-item destructive menu on the placeholder row whose entire meaning is that nothing has happened yet, and it still leaves every *unselected* blank row invisible, so the row the user most wants gone stays unreachable.

**Moving the session directory to a trash location instead of removing it.** Deferred, not rejected. It would change only `delete`'s implementation — move rather than remove — and leaves the rest of this chain untouched, so it stays available if users ask for a recovery window.

**Renaming the deletion seam onto the Workspace registry, beside `archiveSession`.** Rejected: deleting a Session is a Session-lifecycle operation, and the only place that can hold an `AgentHandle` is the API session controller. The Workspace registry contributes metadata cleanup (`forgetSession`) and the activity read, which is the part that genuinely belongs to it.

## Consequences

Every Session the sidebar can show is now deletable, including one the user is looking at, at the cost of a real lifecycle change in the API host: it holds `AgentHandle`s it previously threw away, and closing a Session is now a capability consumers can ask for. That retention is the load-bearing part — a missing or pruned handle degrades to a `session/delete-unavailable` refusal, not to a half-deleted Session.

Deletion is not atomic across its four participants. The stored log, the projection checkpoint, the Workspace registry metadata, and the live Agent are removed in sequence, and a failure after the log is gone leaves the later steps unfinished: the command reports it rather than pretending otherwise. The projection cache's `delete` therefore rejects instead of following the package's "every durable write is fail-soft" rule, because nothing later rewrites a row for an absent Session — a swallowed failure would leak the artifact the caller asked to reclaim.

Subagent-origin Sessions are not deletable through this path: the subagent manager holds its own disposer, and the API host already refuses them. Removing a subagent child is a separate ownership change.

The Session format version is untouched. Deletion removes artifacts; it does not change the stored header or event vocabulary, so no migration or upgrade-guide entry accompanies it. The generation files a *migration* commits are still never renamed, replaced, or deleted — `delete` removes the whole session directory, which is a user-initiated act on the Session rather than a move of a committed generation.

## Related

- [Handle-based session persistence](2026-08-27-handle-based-session-persistence.md) — the seam whose service surface this extends.
- [Released session-format migrations](2026-08-31-released-session-format-migrations.md) — the generation-immutability promise this decision is scoped around.
