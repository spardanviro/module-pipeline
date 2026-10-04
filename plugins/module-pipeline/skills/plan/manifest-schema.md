# Task manifest schema (tasks/task_manifest.yaml)

Paths are relative to the project root. A folder entry ends with `/`.

```yaml
version: 1
project:
  name: Card Game
  spec: docs/spec.md              # the implementation spec, inside the repo
  estimated_lines: 6000           # expected source lines, tests excluded; checks the task count
run:
  id: run-001                     # letters, digits, . _ - ; becomes branch multiagent-runs/run-001
  goal: One-sentence goal of this run
effort:                           # thinking effort per role: low | medium | high | xhigh | max
  preset: balanced                # economy | balanced | quality (default balanced); roles below override it
  module_implementer: high        # one agent per task
  module_reviewer: high           # one read-only reviewer per merged task
  integrator: high                # writes the entry point
  system_reviewer: high           # reviews the integrated result against the spec
shared_layer:                     # required with two or more tasks
  task: shared                    # the task that builds it; it runs first, every other task depends on it
  # existing: [src/shared/, tests/support/]   # instead of task: folders that already hold it
  rules: docs/cross_module_rules.md   # required with two or more tasks: time, state, numbers, order, errors
diagnostics:
  compile_command: ["dotnet", "build"]   # argv list or a shell string; null if none
  test_command: ["dotnet", "test"]       # full test suite after the tasks merge; null if none
  timeout_ms: 300000                     # per command
generated_files:                  # tool output that may appear outside a task's scope
  - "*.uid"                       # file-name pattern ("*" only), matched anywhere
  - "*.import"
  - .godot/                       # a folder
tasks:
  - id: shared
    feature: Game data, the clock, shared helpers and test fixtures
    owned_folder: src/shared/
    systems:                             # what this task builds, one function each
      - { id: data, path: src/shared/data/ }       # the data layer: tuning values, texts, ids
      - { id: clock, path: src/shared/clock.gd }   # a system may be a single file
    estimated_lines: 600
    test_folder: tests/shared/
    support_folder: tests/support/        # test fixtures other tasks' tests import; shared_layer.task only
    prompt_file: work/prompts/shared.md
  - id: combat                    # unique; "integration" is reserved
    feature: Health, damage and the weapons
    owned_folder: src/sim/combat/        # REQUIRED: the one folder this task owns
    systems:                             # each inside owned_folder; they do not reference each other
      - { id: health, path: src/sim/combat/health/ }
      - { id: weapons, path: src/sim/combat/weapons/ }
    estimated_lines: 1400         # this task's share of project.estimated_lines
    test_folder: tests/sim/combat/       # optional; owned exclusively too
    prompt_file: work/prompts/combat.md
    module_report: work/modules/combat/module_report.md          # default shown
    interface_request: work/modules/combat/interface_request.md  # default shown
    allowed_files: []             # extra files/folders outside the task's folder, rarely needed
    acceptance:                   # text lines; quote a line that contains ": "
      - Taking damage lowers health and emits health_changed(old, new)
      - Health never drops below 0; reaching 0 emits died once
      - 'The label reads "health: 85" after a 15-point hit'
    effort: xhigh                 # optional: this task's implementer only
  - id: battle-glue
    feature: Connects spawning, combat and the HUD
    glue: true                    # a glue task: its systems are glue modules
    depends_on: [combat, enemies, hud]   # the tasks it joins; it runs once they are merged
    owned_folder: src/game/battle/
    systems:                             # glue split by function, never one manager for everything
      - { id: enemy-manager, path: src/game/battle/enemy_manager.gd }
      - { id: hud-binder, path: src/game/battle/hud_binder.gd }
    estimated_lines: 500
    prompt_file: work/prompts/battle-glue.md
integration:                      # optional last layer of glue: the entry point; run by /module-pipeline:run
  prompt_file: work/prompts/integration.md
  allowed_files:
    - src/main/                   # the entry point and files at the project root, never inside a task's folder
  acceptance:
    - The game starts, spawns the player and enemies, and the HUD tracks health
  # systems:                      # in a plan without a glue task: the glue modules it writes itself,
  #   - { id: enemy-manager, path: src/main/enemy_manager.gd }   # inside allowed_files, one per function
  estimated_lines: 200
  effort: xhigh                   # optional: same as effort.integrator
```

## Systems, glue and tasks

The code is divided by what it does; the size of the project only decides how
many agents build it.

- A **system** does one thing and lives in its own folder or file. It reads
  the data layer and the shared layer and knows no other system.
- A **glue module** connects systems. It is not meant to be reused. Glue is
  split by function too: several small glue modules, never one manager.
- A **task** is what one agent builds: one `owned_folder` holding the systems
  (or, with `glue: true`, the glue modules) listed under `systems`. A task
  without `systems` is one system, its whole folder.

`depends_on` is for glue: a glue task names the tasks it joins and runs once
they are merged. A task that is not glue depends only on the shared layer,
which is added for it, so all such tasks run in the same wave. Validate warns
when a task that is not glue depends on another task: connect the two in a
glue task, or make them one system if they cannot be separated.

`integration` is the last layer of glue: the entry point, the one place that
calls the systems in the order of a step, and files at the project root. In a
small plan without a glue task it holds the glue modules itself and lists
them under its own `systems`, with paths inside its `allowed_files`.

Validate reports the division as `architecture`: the number of systems and
glue modules, and `gluePercent`, the share of glue in the estimated lines
(only when every task and the integration carry `estimated_lines`). The
module stage's report shows the share that was actually built.

## Model and thinking effort

The model of each role is fixed. The agents that write a module or the glue
run on `sonnet`; the agents that judge the result, and the patcher that
repairs it, run on `opus`:

| Role | Model |
| --- | --- |
| module implementer, integrator | `sonnet` |
| module reviewer, system reviewer, patcher | `opus` |

Both names are aliases: each resolves to the newest model of its family, so a
role follows new versions and never changes family. There is no `model` field;
a manifest that sets one is rejected.

Thinking effort is what the manifest sets. A preset gives every role the same
level:

| Preset | every role |
| --- | --- |
| `economy` | medium |
| `balanced` (default) | high |
| `quality` | xhigh |

Precedence, highest first: a task's own `effort`, the role under `effort:`,
the preset. The pipeline's own commands (prepare, merge, diagnostics) need no
agent: the session runs prepare and the diagnostics after the module stage,
each module reviewer runs its module's merge, and the system reviewer runs the
integration merge and its diagnostics. An old manifest's `pipeline_ops` is
ignored with a warning.

The Main Architect is the session running `/module-pipeline:plan` and
`/module-pipeline:rework`; those skills run on opus at `high` effort. The other
skills (`run`, `integrate`, `status`, `finish`, `clean`) only orchestrate and
run at `medium`.

## Shared layer

Without a shared layer every agent writes its own copy of the same value,
helper, tolerance, color or test fixture, because it only sees the contracts,
not the other tasks' code. The shared layer also holds the data layer: the
tuning values, texts and ids every system reads instead of writing its own.
With two or more tasks the manifest must name one:

- `shared_layer.task`: the task that builds it in this run. It may not have
  `depends_on`; every other task gets it as a dependency, so it runs alone
  in the first wave. Only it may have a `support_folder`, for the test
  fixtures other tasks' tests import.
- `shared_layer.existing`: folders that already hold it, for rework runs and
  existing code bases. They must exist.

Implementers and reviewers are told the shared-layer folders; reviewers flag
code that duplicates what the shared layer provides.

## Cross-module rules

Helpers are only half of what modules share. The other half is decisions:
how time advances and is compared, where state lives and what resets it. An
agent that sees only contracts answers these alone, so one module sums time
step by step, another adds a tolerance, and a third keeps a switch on an
object a restart replaces. Each module passes its review; the defects sit
between them.

- `shared_layer.rules`: the file that settles them, written by the Main
  Architect (template: `cross-module-rules.md` next to this file). Required
  with two or more modules; optional in a patch manifest. A run with one
  module has no shared layer, but the module still meets the integration
  glue: it may write `shared_layer: { rules: docs/cross_module_rules.md }`
  with neither `task` nor `existing`, and the file is checked and passed to
  the agents the same way.
- It must have these headings, each with text under it (HTML comments do not
  count; a topic that does not apply says "Not applicable" and why):
  `Time`, `State`, `Numbers`, `Order`, `Errors`. Validate and prepare report
  what is missing.
- Each rule names the shared-layer export that carries it out and the test
  that pins it; `integration.acceptance` holds one end-to-end check per rule.
- Every agent's claim or merge output names the file as `rules`. Module
  reviewers block a module that sidesteps a rule. The system reviewer
  answers for every topic in `rule_checks` (`followed`, `violated`,
  `not_applicable`); one `violated` entry makes the integration result
  `rework_required`.

## Module size

Set `project.estimated_lines` to the expected source lines (tests excluded).
Validate then reports `sizing` and warns when the module count, not counting
the shared layer, falls outside this band:

| Estimated source lines | Modules |
| --- | --- |
| under 2,000 | 1-2 (one session is cheaper than the pipeline at this size) |
| 2,000-6,000 | 2-4 |
| 6,000-15,000 | 4-10 |
| 15,000 and more | 8-20 |

## Patch runs

`/module-pipeline:rework` writes a patch manifest when every open item is a
small local fix. It has a `patch:` section instead of `tasks` and
`integration`:

```yaml
version: 1
project: { name: Card Game, spec: docs/spec.md }
run: { id: run-001-r1, goal: Fix the opening balance }
shared_layer: { existing: [src/shared/], rules: docs/cross_module_rules.md }   # optional, shown to the agents
patch:
  prompt_file: work/prompts/run-001-r1/patch.md   # every item quoted in full
  allowed_files: [src/data/, tests/data/, tests/enemies/]
  acceptance:                     # one line per item
    - Bats move at 85 px/s
    - The first wave spawns one bat every 1.5 s
  max_changed_lines: 300          # default; added plus deleted lines, tests included, the patch report not
  effort: medium                  # optional; default effort.module_implementer
  # patch_report / interface_request default to work/patches/<run>_*.md
```

One `patcher` agent applies every item in an isolated worktree, limited to
`allowed_files`, which may span several module folders. One reviewer then
merges it, runs the diagnostics and checks each item. There is no
integration stage and no system review. The merge refuses a patch whose
in-scope diff is larger than `max_changed_lines` (status `too_large`); its
worktree is kept, and the next rework takes the module path.

## Generated files

Engines and tools write files nobody asked for: Godot's `.uid` and `.import`
files, caches, build output. A generated file inside a task's own scope is
merged like any other file (Godot `.uid` files belong in git). One outside the
task's scope is dropped from the merge instead of rejecting the whole module.
List only files that really are machine-written; anything listed here can
never cause a scope violation.

## Rules the validator enforces

- Every task has an `owned_folder` (legacy manifests may use `owned_script` for a single file).
- With two or more tasks, `shared_layer` names a task (without `depends_on`) or existing folders,
  and `shared_layer.rules` names the cross-module rules file, which must exist and cover every topic.
  With one task, `shared_layer` may be left out or name `rules` alone.
- `project.estimated_lines` and a task's or the integration's `estimated_lines`, when set, are positive whole numbers.
- One task folder has one owner: no two tasks may own the same folder or nested folders
  (`src/player/` and `src/player/ai/` clash; `src/player/` and `src/players/` do not). Test and support folders count too.
- `systems` entries have an `id` and a `path` inside the task's `owned_folder`; within a task the ids are
  unique and the paths do not overlap. `glue` is `true` or `false`.
- No task, including integration, may list a path inside another task's owned folder or test folder.
- `depends_on` must name existing task ids and must not form a cycle. Tasks run in waves:
  a task starts after everything it depends on is merged. A task that is not glue and depends on
  another task (other than the shared layer) gets a warning, not an error.
- Every `prompt_file` must exist.
- The owned folder, test folder, support folder, module report and interface request are always
  writable by that task; `allowed_files` only adds to them. Globs are rejected; use a folder ending in `/`.
- `generated_files` entries are a file-name pattern without `/` (only `*` as a wildcard), a folder
  ending in `/`, or one exact path.
- Effort levels are `low`, `medium`, `high`, `xhigh` or `max`; `effort.preset` is `economy`,
  `balanced` or `quality`; `effort:` accepts only the four role names above.
- `model` fields and the old `defaults:` section are rejected.
