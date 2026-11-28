# Parley-vous rename: the draft plan

This folder holds the draft plan for renaming Parley to Parley-vous: one package per language (npm `parley-vous`, PyPI `parley-vous`, crate `parley_vous`), the schema and spec at flyingrobots.dev/parley-vous, and Wesley GraphQL SDL generating the code. It is the staging record of the issues before they are filed. Once they are filed, the GitHub issues and their `issue-dag/2` frontmatter are the source of truth, and this folder is history.

> [!NOTE]
> Agent-written on 2026-11-27 and 2026-11-28, recovered from an earlier session's work, and not yet reviewed by a human. Nothing here has been filed.

## What is here

The plan is a task graph and one drafted issue body per task. Table 1 lists the files.

| File | What it is |
| --- | --- |
| `dag.json` | The task graph: 31 nodes, each with a title, a type, a size in hours and the tasks it depends on |
| `dag.v1.json` | The graph before `edits-0744.sh` (kept to show what changed) |
| `edits-0744.sh` | The edits that produced `dag.json` from `dag.v1.json`, then verified it with Taskalisk |
| `render.ts` | Renders one issue body per task into `issues/`, from the canonical Taskalisk task template's sections |
| `issues/*.md` | The drafted issue bodies, all 31; references are symbolic (`@KEY`) until the issues exist |

_Table 1. The files of the draft plan._

The graph and the bodies together are what will be filed.

## The graph

Taskalisk verifies the graph (`python3 ~/.agents/skills/taskalisk/scripts/taskalisk.py --verify-dag dag.json`): it is acyclic and valid. Table 2 gives its shape, as that command reported on 2026-11-28.

| Measure | Value |
| --- | --- |
| Tasks | 31 |
| Frontier (ready first) | A, H1, H2, H3, H4 |
| Critical path | A → B → C → F → G → I → J → N → N4 → R → P → Q (12 tasks) |
| Widest parallel batch | 5 |
| Edge density | 0.0903 |

_Table 2. The graph's shape, from Taskalisk's `--verify-dag`. A, the decision to rename, gates everything on the critical path._

The decision task A comes first; the four H tasks can start beside it.

## Still to do before filing

All 31 bodies are drafted, and every task's prerequisites in `render.ts` match `dag.json`. The five added last (M4, N3, N4, R and X) came with the edits in `edits-0744.sh`; adding them also brought the bodies of K, M1, M3, N, N2 and P in line with the graph. The remaining steps, in order:

1. Show every body to the maintainer word for word; file only what is approved (Taskalisk's *Propose, then apply*).
2. File the issues, replace each `@KEY` with the real `owner/repo#N`, and compile the plan with Taskalisk against GitHub.

After step 3, change nothing here: the issues are the plan.
