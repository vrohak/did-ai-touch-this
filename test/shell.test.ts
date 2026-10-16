import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellTouches, type Dialect } from '../src/shell.ts';
import { win } from './env.ts';

const CWD = 'C:\\repo';

/** The touches a command makes, as `kind path` lines relative to C:/repo. */
function touches(command: string, dialect: Dialect = 'bash', cwd = CWD): string[] {
  const lines = shellTouches(command, dialect, cwd, win).map((f) => `${f.kind} ${f.path.replace(/^C:\/repo\/?/, '') || '.'}`);
  return [...new Set(lines)].sort();
}

test('reading commands read their file arguments, skipping option values', () => {
  assert.deepEqual(touches('cat a.ts b.ts'), ['read a.ts', 'read b.ts']);
  assert.deepEqual(touches('head -n 40 src/a.ts | tail -5'), ['read src/a.ts']);
  assert.deepEqual(touches('head -50 notes.md'), ['read notes.md']);
  assert.deepEqual(touches("sed -n '10,80p' src/a.ts"), ['read src/a.ts']);
  assert.deepEqual(touches("awk -F, '{print $1}' data.csv"), ['read data.csv']);
  assert.deepEqual(touches('wc -l < lines.txt'), ['read lines.txt']);
  assert.deepEqual(touches("jq '.name' package.json"), ['read package.json']);
});

test('grep and rg read a file target and search a folder target', () => {
  assert.deepEqual(touches('grep -n "foo" src/a.ts'), ['read src/a.ts']);
  assert.deepEqual(touches('grep -rn "foo" src/ --include=*.ts'), ['search src']);
  assert.deepEqual(touches('rg -n foo -g "*.ts"'), ['search .']);
  assert.deepEqual(touches('rg --files apps'), ['search apps']);
  assert.deepEqual(touches('cat a.txt | grep foo'), ['read a.txt']);
});

test('listing commands search', () => {
  assert.deepEqual(touches('ls -la'), ['search .']);
  assert.deepEqual(touches('find src -name "*.ts" -type f'), ['search src']);
  assert.deepEqual(touches('cat docs/*.md'), ['search docs']);
});

test('writes: redirects, in-place edits, tee, moves, copies and removals', () => {
  assert.deepEqual(touches('echo hi > out.txt 2>/dev/null'), ['change out.txt']);
  assert.deepEqual(touches('npm test 2>&1 >> log.txt'), ['change log.txt']);
  assert.deepEqual(touches("sed -i 's/a/b/' src/a.ts"), ['change src/a.ts']);
  assert.deepEqual(touches('echo x | tee notes.md'), ['change notes.md']);
  assert.deepEqual(touches('mv old.ts new.ts'), ['change new.ts', 'change old.ts']);
  assert.deepEqual(touches('cp src/a.ts backup/'), ['change backup/a.ts', 'read src/a.ts']);
  assert.deepEqual(touches('rm -f a.ts b.ts'), ['change a.ts', 'change b.ts']);
  assert.deepEqual(touches('git mv a.ts lib/a.ts'), ['change a.ts', 'change lib/a.ts']);
  assert.deepEqual(touches('git checkout -- src/a.ts'), ['change src/a.ts']);
  assert.deepEqual(touches('git restore --staged src/a.ts'), []);
});

test('a heredoc written to a file changes it, and its body is not run as commands', () => {
  assert.deepEqual(touches("cat > notes.md <<'EOF'\nrm -rf everything\ncat secret.txt\nEOF\nls"), ['change notes.md', 'search .']);
});

test('git reads the files a diff, show or blame names', () => {
  assert.deepEqual(touches('git diff HEAD~1 -- src/a.ts'), ['read src/a.ts']);
  assert.deepEqual(touches('git show HEAD:src/a.ts'), ['read src/a.ts']);
  assert.deepEqual(touches('git -C sub blame x.ts'), ['read sub/x.ts']);
  assert.deepEqual(touches('git log --oneline -5 && git status'), []);
  assert.deepEqual(touches("git diff --stat -- . ':!*.lock' ':(exclude)docs'"), ['search .']);
  assert.deepEqual(touches("git ls-files -- '*.ts'"), ['search .']);
});

test('cd, variables and for loops carry through a command', () => {
  assert.deepEqual(touches('cd apps/web && cat src/a.ts'), ['read apps/web/src/a.ts']);
  assert.deepEqual(touches('cd /c/other && cat x.md'), ['read C:/other/x.md']);
  assert.deepEqual(touches('S=build/out; cat "$S/report.txt"'), ['read build/out/report.txt']);
  assert.deepEqual(touches('cat "$UNKNOWN/x.txt"'), []);
  assert.deepEqual(touches('for f in a.ts b.ts; do cat "lib/$f"; done'), ['read lib/a.ts', 'read lib/b.ts']);
  assert.deepEqual(touches('cat ~/notes.md "$HOME/b.md"'), ['read C:/Users/me/b.md', 'read C:/Users/me/notes.md']);
});

test('command substitutions are parsed too', () => {
  assert.deepEqual(touches('echo "$(cat VERSION)"'), ['read VERSION']);
});

test('wrappers and nested shells', () => {
  assert.deepEqual(touches('timeout 30 cat a.ts'), ['read a.ts']);
  assert.deepEqual(touches("bash -lc 'cat a.ts'"), ['read a.ts']);
  assert.deepEqual(touches('pwsh -NoProfile -Command "Get-Content b.ts"'), ['read b.ts']);
});

test('PowerShell cmdlets and their aliases', () => {
  assert.deepEqual(touches("Get-Content -Raw 'src\\a.ts'", 'pwsh'), ['read src/a.ts']);
  assert.deepEqual(touches('Get-Content src/a.ts -TotalCount 50 | Select-Object -First 5', 'pwsh'), ['read src/a.ts']);
  assert.deepEqual(touches('gc a.ts, b.ts', 'pwsh'), ['read a.ts', 'read b.ts']);
  assert.deepEqual(touches('Select-String -Path src\\*.ts -Pattern foo', 'pwsh'), ['search src']);
  assert.deepEqual(touches('Select-String foo notes.md', 'pwsh'), ['read notes.md']);
  assert.deepEqual(touches('Get-ChildItem -Recurse -File src | Measure-Object', 'pwsh'), ['search src']);
  assert.deepEqual(touches("Set-Content -Path out.txt -Value 'x'", 'pwsh'), ['change out.txt']);
  assert.deepEqual(touches("Set-Content out.txt 'hello world'", 'pwsh'), ['change out.txt']);
  assert.deepEqual(touches('New-Item -ItemType Directory -Force -Path dist | Out-Null', 'pwsh'), []);
  assert.deepEqual(touches('New-Item -ItemType File -Path notes.md', 'pwsh'), ['change notes.md']);
  assert.deepEqual(touches('Remove-Item -Recurse -Force build', 'pwsh'), ['change build']);
  assert.deepEqual(touches('Copy-Item a.ts -Destination b.ts', 'pwsh'), ['change b.ts', 'read a.ts']);
  assert.deepEqual(touches('Rename-Item old.md new.md', 'pwsh'), ['change new.md', 'change old.md']);
  assert.deepEqual(touches('Test-Path package.json', 'pwsh'), ['search package.json']);
  assert.deepEqual(touches("'x' | Out-File -FilePath log.txt -Encoding utf8", 'pwsh'), ['change log.txt']);
  assert.deepEqual(touches('npm test > $null 2>&1', 'pwsh'), []);
});

test('PowerShell variables, Set-Location and backslash paths', () => {
  assert.deepEqual(touches("$p = 'docs\\guide.md'; Get-Content $p", 'pwsh'), ['read docs/guide.md']);
  assert.deepEqual(touches('$lines = Get-Content a.txt; $lines.Count', 'pwsh'), ['read a.txt']);
  assert.deepEqual(touches('Get-Content "$env:USERPROFILE\\x.txt"', 'pwsh'), ['read C:/Users/me/x.txt']);
  assert.deepEqual(touches('Set-Location apps; Get-Content a.ts', 'pwsh'), ['read apps/a.ts']);
  assert.deepEqual(touches("[IO.File]::WriteAllText('out.json', $json)", 'pwsh'), ['change out.json']);
});

test('inline Python and Node scripts', () => {
  const py = [
    "python - <<'EOF'",
    "p = 'src/a.py'",
    "s = open(p, encoding='utf-8').read()",
    "open(p, 'w', encoding='utf-8').write(s.replace('a', 'b'))",
    "q = pathlib.Path('docs') / 'notes.md'",
    'print(q.read_text())',
    'EOF',
  ].join('\n');
  assert.deepEqual(touches(py), ['change src/a.py', 'read docs/notes.md', 'read src/a.py']);
  assert.deepEqual(touches(`node -e "const fs=require('fs'); fs.writeFileSync('out.json', fs.readFileSync('in.json'))"`), ['change out.json', 'read in.json']);
  assert.deepEqual(touches("@'\nopen('data.csv').read()\n'@ | python -", 'pwsh'), ['read data.csv']);
  assert.deepEqual(touches('python scripts/build.py'), []);
});

test('a variable resolves to what it held where it is used', () => {
  const py = "python - <<'EOF'\np = 'a.txt'\nprint(open(p).read())\np = 'b.txt'\nopen(p, 'w').write('x')\nEOF";
  assert.deepEqual(touches(py), ['change b.txt', 'read a.txt']);
});

test('interpolated strings in scripts are not paths', () => {
  assert.deepEqual(touches('python -c "open(f\'{root}/x.txt\').read()"'), []);
  assert.deepEqual(touches('[IO.File]::ReadAllText("$dir/x.txt")', 'pwsh'), []);
});
