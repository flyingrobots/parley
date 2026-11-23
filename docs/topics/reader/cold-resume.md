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
  ([flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77)) Fixed since: each entry carries its record's `event`, its `t` and its run's
  `outcome`. A second reader, on the same 50 receipts, opened no id to learn what an entry was
  ([the re-run below](#re-run-against-the-summarised-lens)).
- **`what-changed` never surfaced a single result.** Under a change purpose the failure tier
  ranks first, and it includes warnings: the digest's 20 slots went to 14 graft warnings, 3 errors
  and 3 status-2 `end`s
  ([flyingrobots/parley#76](https://github.com/flyingrobots/parley/issues/76)). Fixed since: the
  failure tier now holds only the failure surface of the runs that failed. The same read over a
  byte-for-byte copy of the same 50 receipts names the 3 errors and the 3 status-2 `end`s, then 14
  `result` records, and no warning.
- **Repeated runs crowd out everything else.** A test suite repeats the same invocations, and the
  digest named near-identical runs instead of distinct events
  ([flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79)). Fixed since: a
  digest folds runs of one invocation with one result. See
  [folding repeated runs](#folding-repeated-runs).
- **The drill-down had no byte bound.** Eight footprint results, each embedding a Markdown report,
  overflowed what the reader's harness would show inline. It now takes `budget.bytes`, and an id
  past the bound comes back `over_budget` with its size
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


## Re-run against the summarised lens

After [flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77) gave every lens
entry a summary, the exercise was run again on 2026-11-22 to see whether the summary saved the
drill-downs it was meant to save.

| | |
| --- | --- |
| History | The same 50 footprint receipts, copied byte for byte into a fresh directory. The first reader's own receipts were left out |
| Window | The same seven days, `1794790009000` to `1795394809000`. The reader was told the time instead of running `date`, so the window matched |
| Code | `lens-entry-summary` at `ab41bc7`, before flyingrobots/parley#76 and flyingrobots/parley#78 were merged into it. Under `what-changed`, warnings still ranked in the failure tier, and a drill-down had no byte bound |
| The reader | A fresh agent, under the same rules and the same two instruments, with the asker's task set to `flyingrobots/parley#77` |

The first command, captured:

```text
$ cold query --view everything --from 1794790009000 --to 1795394809000
```

The digest line it printed, captured. The receipt of the read holds the same line:

```json
{"event":"lens","t":1795395743020,"seq":6,"run":"01M82YSV5X7T7FRYS4A1D5M41R","query":{"run":"01M82YSV5X7T7FRYS4A1D5M41R","seq":2},"asker":{"tool":"claude-code","cwd":"/private/tmp/claude-501/-Users-james-git-parley/006f3cdc-373a-4f61-828f-0e1658b9fb66/scratchpad/cold-resume-77c/footprint","task":"flyingrobots/parley#77"},"view":"everything","budget":{"records":20},"window":{"from":1794790009000,"to":1795394809000},"loss":{"bound":"count-only","excluded":488},"records":[{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":1,"event":"receipt.head","t":1795387051226,"outcome":"undetermined"},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":2,"event":"receipt.step","t":1795387051227,"outcome":"undetermined"},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":3,"event":"receipt.step","t":1795387051227,"outcome":"undetermined"},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":4,"event":"receipt.step","t":1795387051237,"outcome":"undetermined"},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":1,"event":"receipt.head","t":1795387052271,"outcome":"undetermined"},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":2,"event":"receipt.step","t":1795387052272,"outcome":"undetermined"},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":3,"event":"receipt.step","t":1795387052272,"outcome":"undetermined"},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":4,"event":"receipt.step","t":1795387052282,"outcome":"undetermined"},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":1,"event":"receipt.head","t":1795387052377,"outcome":"undetermined"},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":2,"event":"receipt.step","t":1795387052379,"outcome":"undetermined"},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":3,"event":"receipt.step","t":1795387052379,"outcome":"undetermined"},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":4,"event":"receipt.step","t":1795387052393,"outcome":"undetermined"},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":1,"event":"receipt.head","t":1795387077000,"outcome":"undetermined"},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":2,"event":"receipt.step","t":1795387077001,"outcome":"undetermined"},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":3,"event":"receipt.step","t":1795387077001,"outcome":"undetermined"},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":4,"event":"receipt.step","t":1795387077011,"outcome":"undetermined"},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":1,"event":"receipt.head","t":1795387085651,"outcome":"undetermined"},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":2,"event":"receipt.step","t":1795387085652,"outcome":"undetermined"},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":3,"event":"receipt.step","t":1795387085652,"outcome":"undetermined"},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":4,"event":"receipt.step","t":1795387085664,"outcome":"undetermined"}],"_schema":{"id":"parley.lens","version":"1.0.0"}}
```

It names the same first five runs as the first reader's digest did. This time each entry says it
is a `receipt.head` or a `receipt.step` of a run whose outcome is `undetermined`. The line is
2,744 bytes; the first reader's line, naming the same twenty records, was 1,420.

| | First reader | Second reader |
| --- | --- | --- |
| Queries | 6 | 5 |
| Drill-downs | 8 | 7 |
| Ids opened | 53 | 49, all `opened` |
| Ids opened only to learn an entry's kind or outcome | most of its drill-downs, by its own account | none, by its own account |

The second reader's own words, from its report: "For kind and outcome: none. The digest already
gave the event kind and outcome for every entry." Its first drill-down went straight to the head
and the `error` of the three failed runs. Its `what-failed` digest had named those three records as
`error` entries of `failed` runs.

It reconstructed the same things the first reader did, and also the four bursts and their
commits. For the hung runs it said "most likely killed by a test timeout", and for the 15:21
burst "`node` missing from PATH". It also inferred that the bursts were footprint's test suite
re-run after each commit. These claims were not checked again against `git log`. They match the
claims the table above did check.

What the summary did not settle, by the second reader's account:

- **Which run an entry belongs to.** An entry has no argv, range, error code or commit.
  26 of the 49 ids were heads (`seq` 1), most of them opened only to learn a run's arguments,
  and the three failures had to be opened before the reader could see that they were the same
  `git.diff_failed` case.
- **Why an outcome is `undetermined`.** The digest does not say that the run has no `end`; the
  drill-down's replay ruling does. The reader called this the place where "the most interesting
  failure", the hung runs, was hidden. This and the item above are
  [flyingrobots/parley#83](https://github.com/flyingrobots/parley/issues/83). Fixed since: a third
  reader opened 4 heads, none of them to learn a run's arguments
  ([the re-run below](#re-run-against-the-run-sections)).
- **A drill-down with no byte bound** overflowed once, to 57.7 KB, and was asked again with fewer
  ids. That is the [flyingrobots/parley#78](https://github.com/flyingrobots/parley/issues/78)
  failure, and the code under test did not yet have the fix.

The re-run departed from its rules once, and not through the reader. Its first attempt told the
reader it might run "exactly two commands", and the reader took that to mean two invocations. It
made one query of 40 records and one drill-down of 12 ids. Six of those ids were opened only to
learn what `undetermined` meant. The comparison above is from the second attempt, which said each
command could be run as often as the reader liked. That attempt used a fresh copy of the same
receipts, so neither attempt read the other's receipts.

## Re-run against the run sections

After [flyingrobots/parley#83](https://github.com/flyingrobots/parley/issues/83) gave every lens a
`runs` section, the exercise was run a third time on 2026-11-22. The question was whether a reader
still had to open heads to learn which invocation a run was.

| | |
| --- | --- |
| History | The same 50 footprint receipts, copied byte for byte into a fresh directory. Their SHA-256 digests match the second re-run's copy, file for file. No earlier reader's receipts were copied |
| Window | The same seven days, `1794790009000` to `1795394809000`. The reader was told the time |
| Code | `lens-run-identity` at `55f6d22`, with flyingrobots/parley#76, flyingrobots/parley#77 and flyingrobots/parley#78 merged. Each lens names each run once, in `runs`, with the head's `tool`, `v`, `argv` and `inv`, the run's outcome, and a `reason` when the outcome is `undetermined`. An `error` or `warning` entry carries its `code` |
| The reader | A fresh agent, under the same rules and the same two instruments, with the asker's task set to `flyingrobots/parley#83`. Each command could be run as often as it liked, and no pipe, chain or file read was allowed |

The first command, captured:

```text
$ cold query --view everything --from 1794790009000 --to 1795394809000
```

The digest line it printed, captured. The receipt of the read holds the same line, byte for byte:

```json
{"event":"lens","t":1795397099155,"seq":6,"run":"01M83037E5Z1VN2P40S43T6N79","query":{"run":"01M83037E5Z1VN2P40S43T6N79","seq":2},"asker":{"tool":"claude-code","cwd":"/private/tmp/claude-501/-Users-james-git-parley/006f3cdc-373a-4f61-828f-0e1658b9fb66/scratchpad/cold-resume-83/footprint","task":"flyingrobots/parley#83"},"view":"everything","budget":{"records":20},"window":{"from":1794790009000,"to":1795394809000},"loss":{"bound":"count-only","excluded":488},"runs":[{"run":"01M82PGK63JH6SSJXGTQ03C7V3","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~2..HEAD~1"],"inv":"03803fef496f7a07616dc14a5172130f24a87d41b6bd91fb9165af141686834c","outcome":"undetermined","reason":"no_end_in_window"},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~1..HEAD"],"inv":"9f9072bbabf407d294f37d63be06466fd464f2f6ebc428078cb0c704f7e87831","outcome":"undetermined","reason":"no_end_in_window"},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~1..HEAD","--human"],"inv":"9f9072bbabf407d294f37d63be06466fd464f2f6ebc428078cb0c704f7e87831","outcome":"undetermined","reason":"no_end_in_window"},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~1..HEAD"],"inv":"9f9072bbabf407d294f37d63be06466fd464f2f6ebc428078cb0c704f7e87831","outcome":"undetermined","reason":"no_end_in_window"},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~2..HEAD~1"],"inv":"03803fef496f7a07616dc14a5172130f24a87d41b6bd91fb9165af141686834c","outcome":"undetermined","reason":"no_end_in_window"}],"records":[{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":1,"event":"receipt.head","t":1795387051226},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":2,"event":"receipt.step","t":1795387051227},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":3,"event":"receipt.step","t":1795387051227},{"run":"01M82PGK63JH6SSJXGTQ03C7V3","seq":4,"event":"receipt.step","t":1795387051237},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":1,"event":"receipt.head","t":1795387052271},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":2,"event":"receipt.step","t":1795387052272},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":3,"event":"receipt.step","t":1795387052272},{"run":"01M82PGM6W7EDYPGHW0P8DGTMS","seq":4,"event":"receipt.step","t":1795387052282},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":1,"event":"receipt.head","t":1795387052377},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":2,"event":"receipt.step","t":1795387052379},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":3,"event":"receipt.step","t":1795387052379},{"run":"01M82PGMA3W1CEAJ77XXH02NKV","seq":4,"event":"receipt.step","t":1795387052393},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":1,"event":"receipt.head","t":1795387077000},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":2,"event":"receipt.step","t":1795387077001},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":3,"event":"receipt.step","t":1795387077001},{"run":"01M82PHCBKKHDV83Q12ZCRAWGP","seq":4,"event":"receipt.step","t":1795387077011},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":1,"event":"receipt.head","t":1795387085651},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":2,"event":"receipt.step","t":1795387085652},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":3,"event":"receipt.step","t":1795387085652},{"run":"01M82PHMSSX7B4SPRRN8Z10R2Y","seq":4,"event":"receipt.step","t":1795387085664}],"_schema":{"id":"parley.lens","version":"1.0.0"}}
```

It names the same twenty records as both earlier digests. The `runs` section says, before
anything is opened, that the first five runs were `footprint` 0.2.0 on `HEAD~2..HEAD~1`,
`HEAD~1..HEAD` and `HEAD~1..HEAD --human`, and that each is `undetermined` because the window
holds no `end` for it. The line is 3,417 bytes with its newline. The second reader's line, naming
the same records, was 2,744.

| | First reader | Second reader | Third reader |
| --- | --- | --- | --- |
| Queries | 6 | 5 | 14 |
| Drill-downs | 8 | 7 | 4 |
| Ids opened | 53 | 49 | 9, all `opened` |
| Heads (`seq` 1) opened | not counted | 26 | 4 |
| Heads opened to learn a run's arguments | not counted | most of the 26, by its account | none, by its account |

Every count in the third column was checked against the reader's captures: 14 query captures,
4 drill-down captures, and 9 ids, each `opened`.

The four heads it opened, and why, in its own words:

| Id | Why |
| --- | --- |
| `01M82PGK63JH6SSJXGTQ03C7V3:1` | "the resolved commits of an undetermined run" |
| `01M82Q0081H27GGYZ5M0FYMPP3:1` | "the commits for burst A's successful runs" |
| `01M82S0CJBHWR1Z2BVXVRCWBH8:1` | "the commits for burst B" |
| `01M82TFS7AW9F97CFK53PK1K38:1` | "the commits for burst C" |

Each was opened for `resolved.base_commit` and `resolved.head_commit`. They are in the head's
`resolved`, which the run section does not carry. The other five ids were a stalled run's last
step, the text behind `git.diff_failed`, one `result` for what changed, and the two warnings
behind `graft.review_failed`. None of them was opened to learn what an entry or a run was.

It said the digest alone gave it "every run's id, tool, version, arguments, inv hash and outcome
(succeeded, failed, or undetermined with `no_end_in_window`)", and the error and warning codes.
It also noticed that the same arguments carried different `inv` hashes in different bursts, and
read that as `HEAD` having moved between them.

It reconstructed the same three bursts as the earlier readers, with the commits each compared. It
found the 14:37 runs that never ended, the deliberate `no-such-ref-9f8e7d..HEAD` failure in each
burst, and `node` missing from `PATH` at 15:21. It also gave a commit pair the earlier readers did
not: burst B compared `fb09508..7e9959d`. That was checked afterwards: `git log` names `fb09508`
`Merge pull request #15 from flyingrobots/pr-overlap` and `7e9959d`
`Merge pull request #20 from flyingrobots/unanalysed-languages`. As before, it could not say why
the early runs never ended or who started each burst.

What the run sections did not settle, by the third reader's account:

- **Which commits a run compared.** `argv` says `HEAD~1..HEAD`, and only the head's `resolved`
  turns that into two commits. The decision for flyingrobots/parley#83 was to carry `argv` rather
  than `resolved`, because `resolved` is larger and shaped by the tool. Those four heads are what
  that decision cost, filed as
  [flyingrobots/parley#90](https://github.com/flyingrobots/parley/issues/90).
- **Paging.** A query of 400 records under `what-ran` printed more than the reader's harness would
  show inline, and it narrowed the window instead. Most of its 14 queries were that narrowing: the
  cost the earlier readers paid in drill-downs, moved into queries. Folding repeated runs,
  [flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79), is aimed at it.

## Folding repeated runs

This is a measurement, not a fourth cold reader. The same 50 receipts were copied byte for byte
into a fresh directory for each read, SHA-256 identical to the copy the third reader used. Each
of the five views was then read over the same window under the default budget of 20 records,
once with the library at `8a1445c` (before the fold) and once with
[flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79) applied. The script
reads each lens line back from the read's own receipt. "Invocations" counts the distinct `inv`s
among the runs a digest names, and every run in this window has one.

The window holds 508 records in 50 runs, and those runs have 17 distinct `inv`s. Seven groups of
runs share an `inv` and a result, 4, 4, 6, 3, 3, 10 and 10 runs each, so the fold leaves 17 runs
and leaves out 345 records. No two runs share an `inv` and differ in result.

| View | Runs named, before | Invocations, before | Runs named, after | Invocations, after | Runs they stand for, after | `loss`, after |
| --- | --- | --- | --- | --- | --- | --- |
| `what-ran` | 14 | 6 | 11 | 11 | 31 | `excluded` 488, `folded` 345 |
| `what-failed` | 11 | 5 | 9 | 9 | 24 | `excluded` 488, `folded` 345 |
| `what-changed` | 10 | 6 | 8 | 8 | 13 | `excluded` 488, `folded` 345 |
| `how-it-decided` | 7 | 2 | 6 | 6 | 17 | `excluded` 488, `folded` 345 |
| `everything` | 5 | 2 | 4 | 4 | 10 | `excluded` 488, `folded` 345 |

Every digest still names 20 records and excludes 488, because the default budget is a record
count. What changed is which 20: before, a digest of 20 named at most 6 distinct invocations;
after, every run it names is a distinct invocation and result. Under `what-ran` it now reaches
from the 14:37 burst to the `543477a~1..543477a` run of the third, where it stopped in the second
burst before. Byte sizes fell too, from 5,145 to 4,505 bytes under `what-ran`, because a fold
names fewer runs and so pays for fewer sections.

Two sections of the `what-ran` digest after the fold, captured:

```jsonl illustrative
{"run":"01M82PJNQXQBW5ZRRM8T0MENJ7","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~2..HEAD~1"],"inv":"03803fef496f7a07616dc14a5172130f24a87d41b6bd91fb9165af141686834c","outcome":"undetermined","reason":"no_end_in_window","folded":{"runs":4,"records":12}}
{"run":"01M82S0D86ZC0QZWGHDV2A5HZJ","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~1..HEAD","--human"],"inv":"70377768731b22e10242fac4cfac373e8edf08cfd2fc4ba3adc9a25ce2a5dca5","outcome":"succeeded","folded":{"runs":10,"records":117}}
```

The fences are labelled illustrative because each line is a fragment of a lens, not a message.
The first says the four 14:37 runs on `HEAD~2..HEAD~1` never ended. The second is the second
burst's ten runs of `HEAD~1..HEAD`, six without `--human` and four with it. footprint gives runs
with and without the flag the same `inv`, so they are one invocation. The section shows the
representative's own `argv`, which for that group happens to carry `--human`. This is
what folding by `inv` rather than by `argv` means, as the issue chose.

## How the exercise departed from its rules

The reader broke its rules twice, and its report says so. Some commands chained two allowed
commands with `;`. Once, it piped a drill-down's output through `cut` to shorten long lines. The
captured file holds that drill-down's full output, because the instrument writes its capture before
anything downstream sees the output. The reader saw less than the capture holds. It did not see
more.

The first smoke test of the instruments, before the reader started, made one capture, and that
capture was deleted. It was a usage message that read and recorded nothing, so the reader's
history was untouched.
