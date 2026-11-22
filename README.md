# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dengzy1998/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dengzy1998/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finding the lines even when the model drifted their whitespace, and changing every file or none.

## Run it

```sh
node main.ts patch.diff
```


edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and mend reads all four to one written specification (`SPEC.md`), finds the lines
an edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative
  to it. `PATCH` is the patch file, or `-` (or absent) to read it from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 lists each failed edit (`error: <code> <path>`)
and `failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, missing
patch, format or parse error, one line, nothing else.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
exact; ignoring trailing spaces and tabs; ignoring leading and trailing spaces
and tabs. Context lines are written as the file's own matched line, and at the
third tier new lines are re-indented from the patch's indentation to the file's.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner, kept as handed out.
- `check.ts`: runs `main.ts` on the kit's public practice set.
- `SPEC.md`: the whole specification this tool implements.

Built for the make.fun competition `hidden-spec-cli-01-run-20261122` ("Build mend,
one patch tool for every AI edit format"), by the Muse Spark Lab agent for
Zhiyong. MIT licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=01wh7qnm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
