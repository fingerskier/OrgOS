> **STATUS: Historical (frozen).** SDD build/review ledger for the beta branch, committed here for the record.
> The recommended fast-follows and the resolveActor first-login race are **since fixed on `main`**
> (edd7a96 typecheck, 9dd287e authz-before-append guard test, 90e4823 unsignSid, dae76d1 registration race).
> Test counts quoted below are stale. Still-open minors were extracted to [ROADMAP.md](../../../ROADMAP.md).

# OrgOS Beta — SDD Progress Ledger

Plan: docs/superpowers/plans/2026-06-26-orgos-beta.md
Branch: feat/orgos-beta
Base (branch start): 60b78fb
Plan locked at: 64f163e (docker/pg_jsonschema fixes verified empirically)
Merge-base for final review: `git merge-base main HEAD` (= 13b43c5)

## Tasks
Task 1: complete (commit cc49b4c, base 64f163e, review clean — haiku reviewer, ✅ spec, 0 issues)
Task 2: complete (commit e0f52c7, base cc49b4c, review clean — ✅ spec, trailers verified, Minor-only)
Task 3: complete (commit f521c3a, base e0f52c7, review clean — ✅ spec, trailer verified, 0 issues)
Task 4: complete (commit 7db751f, base f521c3a, review clean — ✅ spec, trailer verified, 0 issues)
Task 5: complete (commits 40ba605..9f51098, base 3838c65, review ✅ spec + Approved; Important null-streamId 23505→re-throw guard fixed in 9f51098, appender test green 3/3; ⚠️ no-event-mutation + freshSchema search_path both resolved by controller — no gap)
Task 6: complete (commit e412b3a, base 9f51098, review ✅ spec + Approved; DONE_WITH_CONCERNS deviations both endorsed by reviewer — fileURLToPath Windows fix + tx-as-Sql cast; ⚠️ updated_at col confirmed present in migration 002 — no gap)
Task 7: complete (commit 0b745c8, base e412b3a, review ✅ spec + Approved; security invariants verified — hash-only storage, atomic single-use UPDATE…RETURNING, 256-bit entropy)
Task 8: complete (commit 7c3f67a, base 0b745c8, review ✅ spec + Approved; authz→validate→append→sync order verified, ValidationError re-used not redefined, resolveActor registers once; approved fileURLToPath fix in identity.test.ts)
Task 9+10: complete (commits 7a59bf6..15d2493, base 7c3f67a, review ✅ spec + Approved).
  MERGED into one dispatch — mutual import dependency: server.ts (T9) imports registerAuth from
  ./transport/auth.js (T10); auth.test.ts (T10) imports buildApp from server.ts (T9). No green
  intermediate state where T9 commits alone, so splitting would force committing failing tests
  (violates TDD). Implemented both → full suite 36/36 green (7a59bf6, single commit).
  Pre-approved deviations applied & confirmed by reviewer: Windows fileURLToPath in both test files;
  listenFromDb method name (brief prose "notifyFromDb" was a typo).
  Two ⚠️ both resolved by controller (loginTokens.ts & commands.ts NOT in this commit's 7 files →
  unchanged from reviewed T7/T8; hash-only storage + canAppend-before-append invariants intact).
  Important (as-any cast on registerAuth defeating excess-property checking) FIXED in 15d2493:
  dropped unused `queries` arg so literal matches AuthDeps exactly, cast removed; transport tests 6/6 green.
Task 11: complete (commit 494f0f3, base 15d2493, review ✅ spec + Approved; web typecheck 0 errors).
  Plus chore commit 906a882 (web/package-lock.json — matches server/ lockfile convention; not in brief).
  App.tsx imports Chat from ./Chat.js (T12's file) → T11 committed an intentional placeholder
  web/src/Chat.tsx (`export function Chat(){return null}`) so the typecheck is green; T12 REPLACES it.
  ⚠️ resolved: brief interface PROSE says useSession() returns signIn(email) but the CODE implements
  refresh() — T11 is internally consistent (Session iface = refresh, nothing calls signIn; real sign-in
  is Login→POST /auth/request→magic link→refresh). ACTION at T12 brief-gen: verify T12 doesn't call
  signIn from the hook; if it does, fix to use refresh/actual flow.
Task 12: complete (commits e24410f..122275e, base 906a882, review ✅ spec + Approved; web typecheck 0 errors).
  Important (plan-mandated 409-retry stale-closure bug) FIXED in 122275e: post() now ALWAYS fetches a
  fresh ThreadView before computing streamSeq, so both first attempt and the 409 retry use current
  streamVersion (was reading closed-over `view` → retry re-posted same streamVersion+1 → re-409 uncaught).
  Fix FULFILLS plan prose ("retries once on 409 by refetching"), so no human escalation needed. Re-review
  (sonnet) confirmed fix resolves the finding, no regression, retry-once contract intact. Chat.tsx unused
  signIn concern moot — Chat consumes api directly, not useSession.

Task 13: complete (commits 36805d2..d32d5bf, base 122275e, review ✅ spec + Approved). FINAL TASK.
  Deliverable: README.dev.md quickstart + README.md pointer + verified end-to-end run.
  Implementer's 36805d2 worked around a Windows entrypoint bug by inlining server-launch into the
  dev/start npm scripts as a `tsx --eval` string DUPLICATING server.ts:73-77 (DRY violation). Controller
  fixed the ROOT CAUSE in d5a9e1e: server.ts isMain guard was `import.meta.url === \`file://${argv[1]}\``
  (never matches on Windows — backslash/relative argv) → fixed to realpathSync(fileURLToPath(import.meta.url))
  === realpathSync(argv[1]) with try/catch + argv guard; reverted dev/start to clean `tsx --env-file=.env
  [watch] src/server.ts`. EMPIRICALLY VERIFIED: npm run start → "OrgOS server on :8787" + POST /auth/request
  200 w/ devLink (no enum); full suite 36/36 green. Reviewer traced the guard sound across all cases
  (argv absent→false so vitest never auto-listens; relative; Windows abs; realpath throw→false; POSIX).
  Two review Minors BOTH FIXED in d32d5bf: README console hint corrected to real ConsoleMailer format
  `[magic-link] to=<email>` (was misleading "devLink:"); added "shown in the UI" framing.
  This was the env-loading risk I de-risked pre-dispatch: loadConfig reads process.env directly, NO dotenv
  anywhere → brief's `cp .env.example .env && npm run dev` was broken; resolved via `tsx --env-file=.env`
  (verified tsx 4.19 forwards the Node flag). server/.env stays git-ignored, never committed.

## FINAL whole-branch review (opus) — COMPLETE
Package: review-60b78fb..d32d5bf.diff (merge-base `git merge-base main HEAD` = 60b78fb; main's later
ARCH/TWINS/QUERY docs commits are NOT ancestors of this branch — divergence at 60b78fb is correct).
Verdict: "Ready after must-fix items." All 10 security/architecture invariants verified HOLD with
file:line evidence (log sacred / hash-only token / no-enum / atomic single-use consume / canAppend-before-
append / domain purity / exact cookie opts / web credentials+withCredentials / error mapping / 23505+P0001).
Full slice present; deviations (422→400 fold, chat_thread+/projections/threads for UI) judged acceptable.
ONE must-fix (Important): GET /events + GET /projections/{actors,threads,chat} had NO requireActor guard
while POST /events and /stream did → unauthenticated read of actor emails + all chat on 0.0.0.0 host.
FIXED in 7a309c2 (TDD): `await requireActor(req)` prepended to all 4 routes (auth before input-validation);
4 new 401 tests added; rest.test.ts 4/4, full suite 37/37 green. Adversarially re-verified (sonnet): all
data-returning routes guarded, tests non-vacuous, getActor rejects missing/forged/unknown cookies, no
regression, no other leak (auth-flow endpoints correctly open). HEAD now 7a309c2; branch READY TO MERGE.

### New Minors from final review (added to roll-up, KEEP-OPEN for fast-follow)
- resolveActor concurrent-first-login race: two simultaneous logins for a NEW email append 2 actor.registered
  w/ different actor_ids; actor_state upsert has ON CONFLICT(actor_id) but not (email) → 2nd row violates
  email UNIQUE inside sql.begin → batch rolls back, checkpoint unadvanced → identity projector WEDGES on
  retry. Plan called it "harmless" — inaccurate. Vanishingly rare for magic-link beta. Fix later: pre-claim
  email INSERT…ON CONFLICT(email) DO NOTHING, or advisory lock on normalized email.
- close() projector.stop() containment (already in roll-up) is INERT today: projector.start() never called
  (server.ts uses tick() only), so stop()'s listener is null and can't throw. Not an active leak.

### Final-review triage of accumulated Minors
MUST-FIX before merge: NONE remaining (the one Important must-fix is fixed in 7a309c2).
Recommended FAST-FOLLOWS (post-merge, do not block):
  1. PROJECT-WIDE: add `@types/node` devDep + a `typecheck` script — currently tsconfig `types:["node"]` but
     @types/node absent → `tsc --noEmit` can't run; tsx/vitest strip types unchecked. Highest-priority FF
     since this is the reusable foundation. (Runtime green, so non-blocking now.)
  2. Task 8: add `appender.append not-called` assertion to the authz-reject test (protects canAppend-before-
     append invariant against future reorders).
  3. Task 9+10: extract `unsignSid(app,req,SID)` — cookie-unsign path duplicated in server.ts getActor &
     auth.ts currentActor (both identical/correct now; DRY the security-critical path).
All other roll-up Minors: KEEP-OPEN (cosmetic / per-spec dev behavior / UX niceties / acceptable at beta scale).

## Minor findings roll-up (for final review)
- Task 2 (eventTypes.ts:81): non-null assertions `m[1]!..m[3]!` after regex match — safe, cosmetic.
- Task 2 (eventTypes.test.ts): no explicit test that `parseFqType` throws on malformed input (covered indirectly).
- Task 5 (appender.ts:44): `rows[0]!` non-null assertion on INSERT…RETURNING — always returns 1 row, safe/cosmetic.
- Task 5 (schemaCache.ts second loop): re-aliases EVENT_TYPES keys → ids; redundant unless parseFqType normalizes fq format — add a clarifying comment.
- Task 5 (appender.ts:42): metadata defaults to `sql.json({})` not null — fine if column is NOT NULL; revisit if column is nullable.
- Task 6 (projector.ts ~178,184): `seq > ${from}` relies on postgres.js untyped-param inference (works; bigint inferred). Harden as `${from}::bigint` for resilience/readability.
- Task 6 (projector.ts Projection iface): `namespaces: string[]` added vs brief's iface (correct, implied by brief's filter note) but undocumented — add JSDoc on role/empty-array semantics.
- Task 7 (mailer.ts:56-57): `ConsoleMailer.sendMagicLink` console.logs the link; surfaces in vitest output. Per-spec (dev mailer) but consider `silent`/spy if pristine CI output is wanted.
- Task 7 (loginTokens.ts:24): `makeLoginTokens` return type inferred, not annotated — explicit return type/interface would document the public contract.
- Task 8 (commands.test.ts authz test): "rejects unauthorized type" does not assert `appender.append` not called — a future reorder of authz-after-append would slip past. Add the not-called assertion.
- Task 8 (identity.ts:95): `handleFromEmail` redundantly `.toLowerCase()`s an already-normalized email — cosmetic.
- Task 9+10 (server.ts getActor vs auth.ts currentActor): duplicated cookie-unsign+validate path written twice — extract `unsignSid(app, req, SID): string | null` so the security-critical path lives in one place.
- Task 9+10 (server.ts isMain guard): `import.meta.url === \`file://${process.argv[1]}\`` fails on Windows (argv backslashes vs file:// forward slashes) → `npm start` entrypoint won't fire on Windows. Inherited verbatim from brief. Fix: `fileURLToPath(import.meta.url) === process.argv[1]`. Relevant to Task 13/production packaging.
- Task 9+10 (server.ts close()): no error containment around `projector.stop()`/`app.close()` — if `projector.stop()` throws, `app.close()`+`sql.end()` are skipped (leak). `sub.unlisten()` already try/caught; wrap the rest too.
- PROJECT-WIDE (tsconfig.json `"types":["node"]` but `@types/node` not a devDependency): `tsc --noEmit` fails at type-lib resolution → NO static typecheck in the pipeline; vitest/tsx (esbuild) strips types without checking. Consider adding `@types/node` + a `typecheck` script before merge (Task 13/CI). (NB: this is the SERVER tsconfig; web/ typechecks fine via its own tsconfig.)
- Task 11 (web/src/auth.tsx:137 signOut): no try/finally — if `POST /auth/logout` throws, `setActor(null)` never runs and client stays "signed in". Per-spec (brief code). Fix: `try { await api.post('/auth/logout', {}) } finally { setActor(null) }`.
- Task 11 (web/src/auth.tsx:148 React.FormEvent): used via @types/react global namespace without an explicit import — fragile if isolatedModules added or @types narrows. Per-spec. Prefer `import type { FormEvent } from 'react'`.
- Task 11 (web/src/auth.tsx Login.submit): no try/catch around `api.post('/auth/request')` — a failed request leaves the form frozen with no feedback. Per-spec. Add error state + display before ship.
- Task 11 (web/src/auth.tsx:138 useEffect [] deps): mount-only `refresh()` would trip react-hooks/exhaustive-deps if a linter is enabled. Per-spec. Wrap `refresh` in useCallback if linting.
- Task 12 (Chat.tsx:48 send): `setDraft('')` clears the draft BEFORE the post; if the post throws (non-409, or 2nd 409), the typed message is lost with no way to recover. Consider restoring `draft` in the catch, or clearing only after success.
- Task 12 (Chat.tsx:79 "No messages yet."): shown whenever `view` is empty — including before any thread loads / when `active` is null — so it renders even with no thread selected. Cosmetic; gate on `active`.
- Task 12 (Chat.tsx:31 SSE handler): refetches threads + open thread on EVERY broadcast seq, not just appends relevant to the open thread — fine at beta scale, O(events) refetch storm at scale. Consider filtering by stream/subject if the seq payload carries it.
- Task 12 (Chat.tsx:62 happy-path extra GET): the 409-fix makes every send do an unconditional GET before POST (plus loadThread after) — accepted trade-off for retry correctness; revisit only if send latency matters.
