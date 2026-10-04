// 0.12.0: the code is divided by function (systems and glue modules); size only decides how many tasks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateManifest } from '../scripts/lib/manifest.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { RULES_TEXT, cli, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));
const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };

/** Two tasks of systems, one glue task that joins them, and the entry point. */
const GAME = `version: 1
project:
  name: Game
  spec: docs/spec.md
  estimated_lines: 3000
run:
  id: run-001
  goal: Build the game
effort:
  preset: economy
diagnostics:
  compile_command: null
shared_layer:
  existing: [src/common/]
  rules: docs/cross_module_rules.md
tasks:
  - id: combat
    feature: Health and weapons
    owned_folder: src/sim/combat/
    systems:
      - { id: health, path: src/sim/combat/health/ }
      - { id: weapons, path: src/sim/combat/weapons/ }
    estimated_lines: 1200
    prompt_file: work/prompts/combat.md
  - id: view
    feature: HUD and world rendering
    owned_folder: src/view/
    systems:
      - { id: hud, path: src/view/hud.gd }
    estimated_lines: 900
    prompt_file: work/prompts/view.md
  - id: battle
    feature: Connects combat and the view
    glue: true
    depends_on: [combat, view]
    owned_folder: src/game/battle/
    systems:
      - { id: enemy-manager, path: src/game/battle/enemy_manager.gd }
      - { id: hud-binder, path: src/game/battle/hud_binder.gd }
    estimated_lines: 600
    prompt_file: work/prompts/battle.md
integration:
  prompt_file: work/prompts/integration.md
  allowed_files: [src/main/]
  estimated_lines: 300
`;

function gameProject() {
  const project = makeProject(GAME);
  for (const id of ['combat', 'view', 'battle']) {
    write(project.root, `work/prompts/${id}.md`, `Build ${id}.\n`);
  }
  cli(project.root, 'commit-planning', project.manifest);
  return project;
}

test('a task lists its systems, glue tasks join other tasks, and validate describes the division', () => {
  const manifest = parse(GAME);
  assert.deepEqual(manifest.warnings, [], 'tasks of systems depend on nothing, the glue task on both');
  assert.deepEqual(manifest.tasks.map((task) => [task.id, task.glue, task.systems.map((system) => system.id)]), [
    ['combat', false, ['health', 'weapons']],
    ['view', false, ['hud']],
    ['battle', true, ['enemy-manager', 'hud-binder']],
  ]);
  assert.deepEqual(manifest.architecture, { moduleTasks: 2, systems: 3, glueTasks: 1, glueModules: 3, gluePercent: 30 });
  assert.equal(manifest.sizing.modules, 3, 'size counts tasks, glue tasks included, not systems');

  const noEstimate = parse(GAME.replace('    estimated_lines: 900\n', ''));
  assert.equal(noEstimate.architecture.gluePercent, null, 'the share needs an estimate for every task');
  assert.deepEqual(parse(GAME.replace(/\n {4}systems:\n( {6}- .*\n)+/g, '\n')).architecture, {
    moduleTasks: 2,
    systems: 2,
    glueTasks: 1,
    glueModules: 2,
    gluePercent: 30,
  }, 'a task without a list is one system');
});

test('a small plan without a glue task lists the glue modules the integration writes itself', () => {
  const small = GAME.replace(/  - id: battle\n[\s\S]*?prompt_file: work\/prompts\/battle\.md\n/, '').replace(
    '  allowed_files: [src/main/]\n',
    '  allowed_files: [src/main/, index.html]\n  systems:\n    - { id: enemy-manager, path: src/main/enemy_manager.gd }\n    - { id: hud-binder, path: src/main/hud_binder.gd }\n    - { id: page, path: index.html }\n',
  );
  const manifest = parse(small);
  assert.deepEqual(manifest.integration.systems.map((system) => system.id), ['enemy-manager', 'hud-binder', 'page']);
  assert.deepEqual(manifest.architecture, { moduleTasks: 2, systems: 3, glueTasks: 0, glueModules: 3, gluePercent: 13 });
  assert.throws(() => parse(small.replace('path: src/main/hud_binder.gd', 'path: src/view/hud_binder.gd')), /integration\.systems\[1\]\.path src\/view\/hud_binder\.gd is outside src\/main\/, index\.html/);

  const { root, manifest: file } = makeProject(small);
  for (const id of ['combat', 'view']) {
    write(root, `work/prompts/${id}.md`, `Build ${id}.\n`);
  }
  cli(root, 'commit-planning', file);
  cli(root, 'prepare', file);
  const claim = cli(makeAgentWorktree(root, 'entry-claim'), 'claim', '--run', 'run-001', '--task', 'integration').json;
  assert.deepEqual(claim.task.systems.map((system) => system.path), ['src/main/enemy_manager.gd', 'src/main/hud_binder.gd', 'index.html']);
});

test('modules that reference each other get a warning; glue and the shared layer do not', () => {
  const direct = parse(GAME.replace('    prompt_file: work/prompts/view.md\n', '    depends_on: [combat]\n    prompt_file: work/prompts/view.md\n'));
  assert.deepEqual(direct.warnings, [
    'view depends on combat: modules must not reference each other. Connect them in a glue task (glue: true) that depends on both, or make them one system if they cannot be separated.',
  ]);
  const onGlue = parse(GAME.replace('    prompt_file: work/prompts/view.md\n', '    depends_on: [battle]\n    prompt_file: work/prompts/view.md\n').replace('depends_on: [combat, view]', 'depends_on: [combat]'));
  assert.match(onGlue.warnings[0], /^view depends on battle/);

  const sharedTask = GAME.replace('  existing: [src/common/]\n', '  task: combat\n');
  assert.deepEqual(parse(sharedTask).warnings.filter((warning) => /reference each other/.test(warning)), [], 'depending on the shared layer is what tasks do');
});

test('systems must sit inside the task folder, apart from each other, and glue is a yes or no', () => {
  const bad = (from, to) => () => parse(GAME.replace(from, to));
  assert.throws(bad('path: src/sim/combat/health/', 'path: src/sim/health/'), /combat\.systems\[0\]\.path src\/sim\/health\/ is outside src\/sim\/combat\//);
  assert.throws(bad('path: src/sim/combat/weapons/', 'path: src/sim/combat/health/armor/'), /health \(src\/sim\/combat\/health\/\) and weapons \(src\/sim\/combat\/health\/armor\/\) overlap/);
  assert.throws(bad('id: weapons,', 'id: health,'), /combat\.systems lists health twice/);
  assert.throws(bad('      - { id: hud, path: src/view/hud.gd }\n', '      - src/view/hud.gd\n'), /view\.systems\[0\] must be a mapping with id and path/);
  assert.throws(bad('    glue: true\n', '    glue: sometimes\n'), /battle\.glue must be true or false/);
  assert.throws(bad('    estimated_lines: 600\n', '    estimated_lines: many\n'), /battle\.estimated_lines must be a positive whole number/);
  assert.throws(bad('  estimated_lines: 300\n', '  estimated_lines: 0\n'), /integration\.estimated_lines must be a positive whole number/);
});

test('validate and claim tell the session and the agent what a task holds', () => {
  const { root, manifest } = gameProject();
  const validated = cli(root, 'validate', manifest).json;
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  assert.deepEqual(validated.architecture, { moduleTasks: 2, systems: 3, glueTasks: 1, glueModules: 3, gluePercent: 30 });
  assert.deepEqual(validated.modules, [
    { id: 'combat', owns: 'src/sim/combat/', systems: ['health', 'weapons'] },
    { id: 'view', owns: 'src/view/', systems: ['hud'] },
    { id: 'battle', owns: 'src/game/battle/', glue: true, systems: ['enemy-manager', 'hud-binder'] },
  ]);
  assert.deepEqual(validated.waves, [['combat', 'view'], ['battle']], 'every task of systems in one wave, glue after it');

  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'glue-claim');
  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'battle').json;
  assert.equal(claim.task.glue, true);
  assert.deepEqual(claim.task.dependsOn, ['combat', 'view']);
  assert.deepEqual(claim.task.systems, [
    { id: 'enemy-manager', path: 'src/game/battle/enemy_manager.gd' },
    { id: 'hud-binder', path: 'src/game/battle/hud_binder.gd' },
  ]);
});

test('the glue task runs after the tasks it joins, and the report shows its share of the lines built', async () => {
  const { root, manifest } = gameProject();
  const order = [];
  const { result } = await runWorkflow('implement-modules', {
    root,
    args: prepareArgs(root, manifest),
    scenario: {
      implement: ({ taskId, write: put }) => {
        order.push(taskId);
        const folder = { combat: 'src/sim/combat/health', view: 'src/view', battle: 'src/game/battle' }[taskId];
        put(`${folder}/${taskId}.gd`, taskId === 'battle' ? 'a\n' : 'a\nb\nc\n');
        put(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
        return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
      },
      review: () => PASS,
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(order.at(-1), 'battle');

  write(root, '.multiagent/workflow-output.json', JSON.stringify({ result }));
  const recorded = cli(root, 'record', '--from', path.join(root, '.multiagent', 'workflow-output.json')).json;
  assert.deepEqual(recorded.size.perModule, [{ id: 'combat', lines: 3 }, { id: 'view', lines: 3 }, { id: 'battle', lines: 1, glue: true }]);
  assert.equal(recorded.size.gluePercent, 14);
  const report = fs.readFileSync(recorded.reportPath, 'utf8');
  assert.match(report, /7 source line\(s\) changed in the module folders on this run; the plan estimated 3000 for the finished project\. Glue tasks wrote 14% of them\./);
  assert.match(report, /\| battle \(glue\) \| 1 \|/);
});

test('the planning skill, the schema and the agents carry the division by function', () => {
  const read = (...parts) => fs.readFileSync(new URL(path.posix.join('..', ...parts), import.meta.url), 'utf8');
  const plan = read('skills', 'plan', 'SKILL.md');
  assert.match(plan, /\*\*Divide the code by what it does\.\*\*[\s\S]*\*\*Size the project and form the tasks\.\*\*/, 'function first, size second');
  assert.match(plan, /never merge\s+systems to save an agent/);
  assert.match(plan, /Systems never reference each other\. Two that cannot work\s+without calling each other are one system/);
  assert.match(plan, /Never one manager that glues\s+everything together/);
  assert.match(plan, /are parts of one system, not systems, and a helper is\s+not a system either/);
  assert.match(plan, /Design it first,\s+as a data layer/);
  assert.match(plan, /Presentation reads the\s+logic's state through a read-only API/);
  assert.doesNotMatch(plan, /composition belongs to the integration stage/);

  const schema = read('skills', 'plan', 'manifest-schema.md');
  for (const field of ['systems:', 'glue: true', 'estimated_lines:', 'gluePercent']) {
    assert.ok(schema.includes(field), `manifest-schema.md explains ${field}`);
  }
  const rules = read('skills', 'plan', 'cross-module-rules.md');
  assert.match(rules, /the one glue module that calls the systems in that order/);
  assert.match(rules, /one place each in the data layer/);
  assert.equal(RULES_TEXT.includes('## Order'), true, 'the required topics are unchanged');

  assert.match(read('agents', 'module-implementer.md'), /knows no other system/);
  assert.match(read('agents', 'module-reviewer.md'), /a system that reaches into another/);
  assert.match(read('agents', 'system-reviewer.md'), /only glue may know a system/);
  assert.match(read('agents', 'integrator.md'), /Never one manager that\s+glues everything/);
});
