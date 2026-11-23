# A cold resume on real history

What an agent with no other context could reconstruct from parley history alone, using the digest
and the drill-down, and what it could not. Every line quoted as **captured** below is the exact
output of the run described. Nothing has been tidied or filled in. This page explains one
exercise. The reference for the instruments is
[parley-read](../parley-read/README.md#opening-records-by-identity) and
[the reader representation](README.md). It is the Definition of Done of
[flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2) and
[flyingrobots/parley#51](https://github.com/flyingrobots/parley/issues/51).

## The setup

| | |
| --- | --- |
| Repository | [flyingrobots/footprint](https://github.com/flyingrobots/footprint), cloned at `82657085c36d1452f812333381761a7ddb9e1f5c` (`Merge pull request #27 from flyingrobots/large-repo-bound`) |
| History | The 50 receipts in footprint's own `.parley/receipts/` on 2026-11-22, copied byte for byte into the clone. Real footprint 0.2.0 runs wrote them, and nobody in this exercise did. Nothing was generated for the exercise |
| The session reconstructed | Whatever ran footprint in that checkout between 14:37 and 15:49 PST on 2026-11-22. The reader was told nothing about it |
| The reader | A fresh agent, given only the repository path. It was allowed to run `date` and two commands, and nothing else: no `git`, no file reads |
| The instruments | `query`, which calls `queryReceipts` and prints the `parley.lens` line exactly as the read's own receipt holds it, and `open`, which calls `openRecords` and prints each outcome and record in full. Both use the asker `{"tool":"claude-code","task":"flyingrobots/parley#51"}` |
| The truth | footprint's `git log`, and `test/cli.test.ts` at the commits the receipts name. These were checked after the reader had reported |

The reader's window was the seven days up to the moment it started, 16:46:49 PST: POSIX
milliseconds `1794790009000` to `1795394809000`. It held 508 records.

## The first query and its digest

The first command, captured:

```text
$ cold query --view everything --from 1794790009000 --to 1795394809000 --records 20 --note cold resume: first sweep, last 7 days
```

The digest line it printed, captured. This is the line the read's own receipt holds:

```json
{"event":"lens","t":1795394813655,"seq":6,"run":"01M82XXFGB26M2309B4TA0A1WS","query":{"run":"01M82XXFGB26M2309B4TA0A1WS","seq":2},"asker":{"tool":"claude-code","cwd":"/private/tmp/claude-501/-Users-james-git-parley/006f3cdc-373a-4f61-828f-0e1658b9fb66/scratchpad/cold-resume/footprint","task":"flyingrobots/parley#51"},"view":"everything","budget":{"records":20},"window":{"from":1794790009000,"to":1795394809000},"loss":{"bound":"count-only","excluded":488},"records":[{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":1},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":2},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":3},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":4},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":1},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":2},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":3},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":4},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":1},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":2},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":3},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":4},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":1},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":2},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":3},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":4},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":1},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":2},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":3},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":4}],"_schema":{"id":"parley.lens","version":"1.0.0"}}
```

The digest named the first five runs in time order and said `excluded: 488`. The reader treated
the count as an instruction, not an answer. It went on to six queries and eight drill-downs: three
more views over the same window, `what-ran` over two narrower windows, and `how-it-decided` over
one run. Each drill-down named the ids a digest had given it. **All 53 ids it opened came back
`opened`.** None was `run_not_found`, `seq_not_found` or `sidecar_unavailable`. On real history,
every id a digest named resolved. One drill-down outcome, captured. It opens the failing run's
`error` and carries its bundle's replay ruling. The first line is the instrument's own summary of
the outcome, which no parley schema covers:

```text
{"id":"01M82Q0M72VXTQ5RHMVVC2XYHX:4","outcome":"opened","bundle":{"terminated":true,"status":2,"replay":{"unavailable":true,"reasons":["end.status_nonzero"]}}}
```

The second is the record it opened, which `bun run check` validates against `parley.error` 2.0.0:

```json
{"event":"error","t":1795387576576,"seq":4,"run":"01M82Q0M72VXTQ5RHMVVC2XYHX","code":"git.diff_failed","problem":"git diff --numstat no-such-ref-9f8e7d..HEAD exited 128: fatal: ambiguous argument 'no-such-ref-9f8e7d..HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'","remedy":"pass a range git can resolve","remedy_target":"no-such-ref-9f8e7d..HEAD","_schema":{"id":"parley.error","version":"2.0.0"}}
```

## What was reconstructed, checked against the truth

| The reader said | Checked against | Verdict |
| --- | --- | --- |
| Only footprint 0.2.0 ran, against footprint's own repository. The receipts' bookkeeping paths name `/Users/james/git/footprint/.parley/receipts/` | Every receipt head | Right |
| Five bursts of runs, at 14:37–14:39, 14:45–14:46, 15:21, 15:46–15:49 | Receipt timestamps | Right, to the second |
| The 14:45 burst compared `98cc105..e1563ea`, 26 files, +999/−19, adding the landing plan: `src/landing.ts`, its schema, its docs and its tests | `git diff --shortstat 98cc105 e1563ea` printed `26 files changed, 999 insertions(+), 19 deletions(-)`. `e1563ea` is `Merge pull request #16 from flyingrobots/landing-plan` | Right |
| The 15:46 burst compared `f843f19..f1619f1`, 15 files, +1227/−56, adding blast radius and call sites | `git diff --shortstat` printed `15 files changed, 1227 insertions(+), 56 deletions(-)`. `f1619f1` is `Merge pull request #19 from flyingrobots/call-sites` | Right |
| `no-such-ref-9f8e7d..HEAD` failed with exit 2 (`git.diff_failed`) in three bursts, and the invented ref name made it a deliberate probe of the error path | `test/cli.test.ts`, `a base that does not exist is a structured error and exit 2` | Right |
| The 15:21 burst was "certainly scripted, a test suite or loop": about 20 runs in about a second. Every run warned `graft.review_failed` and `graft.exports_failed` with `env: node: No such file or directory`, so structural analysis was unavailable while the runs still exited 0 | The receipts carry that text. The argv set matches `test/cli.test.ts` | Right |
| The 14:37–14:39 runs have four records each and no `end`. The reader "could not determine why": killed, crashed or trimmed | `test/cli.test.ts` at `98cc105`, the `main` those runs compared, sets no timeout, so Bun's five-second default applies. A run with graft answering takes about ten seconds, by the file's own later comment. `CLI_TIMEOUT`, which raises the clock, first appears in `ea881db` on the landing-plan branch and reached `main` in the merge `e1563ea` at 14:45:50. The next burst, six seconds later, is the first whose runs all close with `end`. So the test runner most likely killed each run mid-flight. **This is an inference from the code and the timing, not an observation** | Not reconstructed, honestly so |
| Each burst was "the same smoke matrix" run "after each commit" | Each burst's argv set is the case list of footprint's own CLI test suite, and each burst started seconds after a merge to `main`: 14:45:50 to 14:45:56, 15:20:49 to 15:21:05, 15:46:52 to 15:46:58 | Half right. The pattern was right, but it was footprint's `bun test` on `main` after each merge, not a matrix typed after each commit |
| Before 14:37, nothing could be seen. Retention keeps 50 receipts and deleted the oldest during these runs | Every receipt's `retention: deleted 1 receipt bundle(s)` step. `git log` shows footprint commits from 04:27 that day | Right, and it is a real gap |

## What was missed

- **What the session was actually doing.** The receipts show a test suite run on `main` after each
  merge, and nothing else. `git log` shows a day of red-green work on branches: the export-surface
  diff (`#9`), the landing plan, cross-pull-request overlap, unanalysed languages, call sites
  (`#10`), CI, and a drift test against graft. None of that is in the history, because none of it
  ran footprint in that checkout. The reader reconstructed *what footprint did*, and it did that
  accurately. It could not reconstruct *the session*, because the session's own acts (editing,
  committing, merging, opening pull requests) are not parley runs.
- **No commit messages, branch names or pull request numbers.** The receipts carry commit ids, and
  only `git` turns them into intent. The reader named the landing-plan and call-sites features from
  the file lists in two `result` records, and said it had guessed the `seq` numbers to open to find
  them.
- **Why `network` flipped from `false` to `true` between the 14:46 and 15:21 bursts.** The reader
  flagged it and could not explain it. The receipts do not say, and this page has not established
  it either.
- **Who invoked each run.** Nothing in a receipt says whether a test runner, a shell or an agent
  started the program, so "test suite" was always the reader's inference.

## What that says about the format

What held:

- **The receipts were enough to place every run in time, against the exact commits it compared,
  with its outcome.** `resolved.base_commit` and `resolved.head_commit` in the head carried the
  most weight in the whole exercise.
- **The digest's count did its job.** `excluded: 488` told the reader the first digest was a sliver,
  and it widened deliberately: different views, narrower windows and a larger budget.
- **The drill-down's per-id ruling was read and used.** The reader told runs that never terminated
  (`receipt.no_end`) from runs that failed (`end.status_nonzero`), from the ruling and not from
  guesswork.

What got in the way. Each of these is filed:

- **A digest entry is only `(run, seq)`.** Most drill-downs were spent learning what an entry
  *was* before deciding whether it mattered
  ([flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77)).
- **`what-changed` never surfaced a single result.** Under a change purpose the failure tier
  ranks first, and it includes warnings: the digest's 20 slots went to 14 graft warnings, 3 errors
  and 3 status-2 `end`s
  ([flyingrobots/parley#76](https://github.com/flyingrobots/parley/issues/76)).
- **Repeated runs crowd out everything else.** A test suite repeats the same invocations, and the
  digest named near-identical runs instead of distinct events
  ([flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79)).
- **The drill-down has no byte bound.** Eight footprint results, each embedding a Markdown report,
  overflowed what the reader's harness would show inline
  ([flyingrobots/parley#78](https://github.com/flyingrobots/parley/issues/78)).
- **Reading costs the history it reads.** The reader's 14 reads each left a receipt in the same
  directory. The writer's retention counts every receipt there, so footprint's next run would
  delete 14 of its own oldest bundles to make room for them. This comes from reading
  `packages/parley-emit/src/tool.ts`. It was not executed, because executing it deletes the history
  under study ([flyingrobots/parley#75](https://github.com/flyingrobots/parley/issues/75)).

The plainest lesson is the first item under *What was missed*. A cold resume from parley history
alone reconstructs what the *tools* did, precisely and checkably, and it reconstructs a *session*
only as far as the session acted through parley tools. Version control, the shell and pull requests
are not parley tools.

## How the exercise departed from its rules

The reader broke its rules twice, and its report says so. Some commands chained two allowed
commands with `;`. Once, it piped a drill-down's output through `cut` to shorten long lines. The
captured file holds that drill-down's full output, because the instrument writes its capture before
anything downstream sees the output. The reader saw less than the capture holds. It did not see
more.

The first smoke test of the instruments, before the reader started, made one capture, and that
capture was deleted. It was a usage message that read and recorded nothing, so the reader's
history was untouched.
