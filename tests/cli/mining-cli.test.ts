/**
 * The miner's CLI must make an extracted chip durable. This test deliberately crosses
 * the process boundary: the engine tests cannot catch a flag wired to the wrong option,
 * and a zero exit status cannot catch a project file that forgot the chip it just made.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, suite, test } from '../framework.js';
import { CircuitBuilder } from '../../src/engine/core/build.js';
import { ChipLibrary } from '../../src/engine/core/chip.js';
import { createDefaultLibrary } from '../../src/engine/core/registry.js';
import { buildReferenceProject } from '../../src/engine/synthesis/reference.js';
import { loadProjectText, saveProjectText } from '../../src/engine/io/project-file.js';

suite('CLI');

test('mine --extract --replace --out saves the verified chip and rewritten sheet in one project', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const temp = mkdtempSync(join(tmpdir(), 'circuitforge-mining-cli-'));
  try {
    const project = buildReferenceProject('CLI mining extraction test');
    const b = new CircuitBuilder(project.lib, 'four repeated blocks', project.chips);
    for (let i = 0; i < 4; i++) {
      for (const net of ['a', 'b', 'ci']) b.port(`${net}${i}`.toUpperCase(), 'input', `${net}${i}`, 1);
      const x1 = b.add('xor_gate', { inputs: 2 }, [i * 240, 0]);
      const x2 = b.add('xor_gate', { inputs: 2 }, [i * 240 + 60, 0]);
      const a1 = b.add('and_gate', { inputs: 2 }, [i * 240, 60]);
      const o1 = b.add('or_gate', { inputs: 2 }, [i * 240 + 120, 60]);
      b.at(x1, 'IN1', `a${i}`).at(x1, 'IN2', `b${i}`).at(x1, 'OUT', `x${i}`);
      b.at(x2, 'IN1', `x${i}`).at(x2, 'IN2', `ci${i}`).at(x2, 'OUT', `s${i}`);
      b.at(a1, 'IN1', `a${i}`).at(a1, 'IN2', `x${i}`).at(a1, 'OUT', `g${i}`);
      b.at(o1, 'IN1', `g${i}`).at(o1, 'IN2', `ci${i}`).at(o1, 'OUT', `co${i}`);
      b.port(`S${i}`, 'output', `s${i}`);
      b.port(`CO${i}`, 'output', `co${i}`);
    }
    const circuit = b.finish({ erc: false });
    const input = join(temp, 'source.cfproj');
    const output = join(temp, 'extracted.cfproj');
    writeFileSync(input, saveProjectText(project, { circuit }), 'utf8');

    const child = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--extract', '--replace', '--as-chip', 'cli_extracted_block', '--name', 'CLI extracted block', '--out', output],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(child.status, 0, `the CLI exited successfully (stderr: ${child.stderr})`);
    assertEqual(child.error, undefined, `the CLI did not fail to start (${String(child.error)})`);
    assert(child.stdout.includes('re-measured after the copy'), 'the user sees that extraction was measured');
    assert(child.stdout.includes('Project file written'), 'the result describes the project it saved');

    const text = readFileSync(output, 'utf8');
    const restored = loadProjectText(text, { lib: createDefaultLibrary(), chips: new ChipLibrary() });
    assertEqual(restored.errors, 0, `the output is a loadable project (${restored.diagnostics.map((d) => d.message).join('; ')})`);
    const chip = restored.project.chips.all().find((c) => c.def.tags?.includes('extracted'));
    assert(chip !== undefined, 'the extracted chip is in the project file');
    assertEqual(chip!.def.id, 'cli_extracted_block', '--as-chip selects the new id, without being mistaken for the source chip');
    assertEqual(chip!.def.name, 'CLI extracted block', '--name selects the display name');
    assert(restored.project.lib.get(chip!.def.id) !== undefined, 'its component spec is re-registered');
    assert(restored.project.sheet !== undefined, 'the source sheet is present');
    assertEqual(restored.project.sheet!.componentCount(), 4, 'four repeated blocks became four chip instances');
    assertEqual(restored.project.sheet!.allComponents().filter((c) => c.chipRef === chip!.def.id).length, 4, 'each rewritten instance refers to the extracted chip');

    const refusedPath = join(temp, 'must-not-be-a-fake-project.cfproj');
    const refused = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--extract', '--no-measure', '--out', refusedPath],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(refused.status, 1, 'the CLI returns failure when asked to save a chip it could not verify');
    assert(!existsSync(refusedPath), 'it never puts a text report in a file named like a project');
    assert(refused.stdout.includes('No project file was written'), 'it says why no project was saved');

    const invalidPath = join(temp, 'must-not-fallback-to-another-pattern.cfproj');
    const invalid = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--pattern', 'not-a-pattern', '--extract', '--replace', '--out', invalidPath],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(invalid.status, 1, 'an invalid explicit pattern id is a failed action');
    assert(!existsSync(invalidPath), 'it does not save a different pattern under the requested name');
    assert(invalid.stderr.includes('No other pattern will be substituted instead'), 'it explicitly refuses to fall back to another pattern');

    const noMatchPath = join(temp, 'must-not-save-when-no-chip-matches.cfproj');
    const noMatch = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--replace', '--out', noMatchPath],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(noMatch.status, 1, 'asking to replace a report with no identical library match is a failed action');
    assert(!existsSync(noMatchPath), 'it does not write the mining report as if it were a rewritten project');

    // Extraction can succeed while an explicitly forced replacement is correctly refused.
    // The valid chip is still kept with the original sheet, but the command status remains
    // nonzero so automation cannot mistake the partial operation for a completed rewrite.
    const partialPath = join(temp, 'extracted-but-not-replaced.cfproj');
    const partial = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--extract', '--replace', '--replace-with', 'full_adder', '--out', partialPath],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(partial.status, 1, 'a refused explicit replacement remains a failed action even when extraction succeeded');
    assert(existsSync(partialPath), 'the verified extracted chip is still saved for recovery');
    assert(partial.stdout.includes('Project file written') && partial.stdout.includes('Replacement refused before editing'), 'the partial success and refusal are both reported');
    const partialProject = loadProjectText(readFileSync(partialPath, 'utf8'), { lib: createDefaultLibrary(), chips: new ChipLibrary() });
    assertEqual(partialProject.errors, 0, `the saved partial result remains a valid project (${partialProject.diagnostics.map((d) => d.message).join('; ')})`);
    assertEqual(partialProject.project.sheet!.componentCount(), 16, 'the rejected rewrite did not alter the source sheet');

    const mined = spawnSync(process.execPath, [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--min', '1', '--json'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assertEqual(mined.status, 0, 'the report can be queried as JSON to select a pattern');
    const minedReport = JSON.parse(mined.stdout) as { report: { patterns: Array<{ id: string; inputs: number; outputs: number }> } };
    const near = minedReport.report.patterns.find((p) => p.inputs === 3 && p.outputs === 2);
    assert(near !== undefined, 'the deliberately wrong carry is present in the report');
    const refusedReplacement = join(temp, 'must-not-save-a-near-replacement.json');
    const forced = spawnSync(
      process.execPath,
      [join(root, 'bin/circuitforge.js'), 'mine', '--file', input, '--min', '1', '--pattern', near!.id, '--replace', '--replace-with', 'full_adder', '--out', refusedReplacement],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    assertEqual(forced.status, 1, 'an explicit near-match replacement is a failed action');
    assert(!existsSync(refusedReplacement), 'the CLI does not save an unchanged sheet as if it had been rewritten');
    assert(forced.stdout.includes('Replacement refused before editing'), 'the text says it refused before touching the sheet');
    assert(!forced.stdout.includes('ERC after replacement'), 'a semantic refusal is not mislabeled as an ERC failure');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
