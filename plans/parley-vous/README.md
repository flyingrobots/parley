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
| `issues/*.md` | The drafted issue bodies, 26 of the 31; references are symbolic (`@KEY`) until the issues exist |

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

Five tasks are in the graph but have no drafted body yet. Table 3 lists them.

| Task | Title |
| --- | --- |
| M4 | parley-vous (PyPI) reads receipts: the read API, ported from the TypeScript reader |
| N3 | parley-vous (crate) writes Parley-vous output: the write API |
| N4 | parley-vous (crate) reads receipts: the read API |
| R | The parley-vous CLI (Rust, on the crate) queries history, opens records and checks a captured run (existing parley#138, rewritten) |
| X | A language-agnostic conformance corpus (bash + bats) runs against every parley-vous package |

_Table 3. Tasks without a drafted body. Each needs one before the plan is filed._

The remaining steps, in order:

1. Write the five missing bodies in `render.ts` and regenerate `issues/`.
2. Show every body to the maintainer word for word; file only what is approved (Taskalisk's *Propose, then apply*).
3. File the issues, replace each `@KEY` with the real `owner/repo#N`, and compile the plan with Taskalisk against GitHub.

After step 3, change nothing here: the issues are the plan.
