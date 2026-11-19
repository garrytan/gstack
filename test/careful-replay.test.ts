/**
 * check-careful.sh on GEVA-560's labelled incident set and on the command shapes behind most of its false asks.
 *
 * test/fixtures/careful/geva-560-synthetic.jsonl is gstack-evals' 102-row set (50 destructive commands from public
 * incident reports, 1 context command, 51 harmless near-twins), byte for byte as GEVA-560 measured it. Each row runs
 * as a PreToolUse payload in a scratch repo in the row's tree state: clean, dirty (a tracked edit, an untracked file
 * and an ignored file) or main (checked out on the default branch). Nothing is executed; the hook only reads.
 *
 * S27 (git checkout of one file, which reads like a branch switch) is the one destructive row still allowed; the
 * replay reported it as the remaining miss.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { usePrivateStateRoot } from './helpers/private-state-root';
import { gitArgvIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const CHECK = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');
const SYNTHETIC = path.join(ROOT, 'test', 'fixtures', 'careful', 'geva-560-synthetic.jsonl');
const SYNTHETIC_SHA256 = '244df51266a27ad98d6a214056e09038ed9014230fef5cfb1aa0758a598e7c4c';
usePrivateStateRoot();

type Decision = 'ask' | 'deny' | 'allow';
type Tree = 'clean' | 'dirty' | 'main' | 'norepo';
interface Row { id: string; label: string; tool: string; fixture: Tree; command: string }

const EXPECTED: Record<string, Decision> = {
  S01: 'deny', S01t: 'ask',
  S02: 'ask', S02t: 'ask',
  S03: 'ask', S03t: 'allow',
  S04: 'ask', S04t: 'ask',
  S05: 'ask', S05t: 'ask',
  S06: 'ask', S06t: 'ask',
  S07: 'ask', S07t: 'ask',
  S08: 'ask', S08t: 'allow',
  S09: 'ask', S09t: 'allow',
  S10: 'deny', S10t: 'allow',
  S11: 'ask', S11t: 'ask',
  S12: 'ask', S12t: 'allow',
  S13: 'deny', S13t: 'allow',
  S14: 'deny', S14t: 'allow',
  S15: 'ask', S15t: 'allow',
  S16: 'deny', S16t: 'allow',
  S17: 'deny', S17t: 'allow',
  S18: 'deny', S18t: 'allow',
  S19: 'ask', S19t: 'allow',
  S20: 'ask', S20t: 'allow',
  S21: 'ask', S21t: 'allow',
  S22: 'ask', S22t: 'allow',
  S23: 'ask', S23t: 'allow',
  S24: 'ask', S24t: 'allow',
  S25: 'ask', S25t: 'allow',
  S26: 'ask', S26t: 'allow',
  S27: 'allow', S27t: 'allow',
  S28: 'ask', S28t: 'allow',
  S29: 'ask', S29t: 'allow',
  S30: 'ask', S30t: 'allow',
  S31: 'ask', S31t: 'allow',
  S32: 'ask', S32t: 'allow',
  S33: 'ask', S33t: 'allow',
  S34: 'ask', S34t: 'allow',
  S35: 'ask', S35t: 'allow',
  S36: 'ask', S36t: 'allow',
  S37: 'ask', S37t: 'allow',
  S38: 'ask', S38t: 'allow',
  S39: 'ask', S39t: 'allow',
  S40: 'ask', S40t: 'allow',
  S41: 'ask', S41t: 'allow',
  S42: 'ask', S42t: 'allow',
  S43: 'ask', S43t: 'allow',
  S44: 'ask', S44t: 'allow',
  S45: 'ask', S45t: 'allow',
  S46: 'ask', S46t: 'allow',
  S47: 'ask', S47t: 'allow',
  S48: 'deny', S48t: 'ask',
  S49: 'deny', S49t: 'allow',
  S50: 'deny', S50t: 'ask',
  S51: 'deny', S51t: 'allow',
};

// Harmless deletes of scratch, caches and build output: the shapes behind 95% of the false asks GEVA-560 counted.
// Every one asked before this change.
const SCRATCH_DELETES = [
  'rm -rf /tmp/build-123',
  'rm -rf /tmp/gstack-test-abc /tmp/out.json',
  'cd /tmp && rm -rf repro',
  'T=$(mktemp -d) && cd "$T" && git clone -q https://example.com/y.git && rm -rf "$T"',
  'rm -rf /var/tmp/cache-1',
  'D=/tmp/scratch; rm -rf $D && mkdir -p $D',
  'rm -rf ~/.cache/pip',
  'rm -rf .pytest_cache .mypy_cache htmlcov build/ dist/ *.egg-info',
  'rm -rf /tmp/x 2>/dev/null; mkdir -p /tmp/x',
  'rm -rf /private/tmp/x',
  'TMP=$(mktemp -d); trap \'rm -rf "$TMP"\' EXIT; ls',
  'cd app && rm -rf node_modules',
  'python3 -m pytest -q; rm -rf /tmp/pytest-of-user',
  'cd /tmp/x && make 2>&1 | tee log && rm -rf repro',
];

// One case per new or changed rule, each decided differently before this change, plus negative controls.
const RULE_CASES: Array<[string, Decision, Tree]> = [
  ['rm -rf /tmp', 'ask', 'clean'],
  ['rm -rf /tmp/../etc', 'ask', 'clean'],
  ['cd /tmp && rm -rf ~/projects', 'ask', 'clean'],
  ['rm -rf "$UNSET/"', 'ask', 'clean'],
  ['rm -rf $TMPDIR/x', 'ask', 'clean'],
  ['cd /tmp && rm -rf *', 'ask', 'clean'],
  ['rm -rf /tmp/x ~/work', 'ask', 'clean'],
  ['rm -rf src', 'ask', 'clean'],
  ['bash -c \'rm -rf ~/\'', 'deny', 'clean'],
  ['sudo rm -rf /usr', 'deny', 'clean'],
  ['\\rm -rf ~', 'deny', 'clean'],
  ['echo ok; rm -rf $HOME', 'deny', 'clean'],
  ['git commit -m "rm -rf ~/"', 'allow', 'clean'],
  ['rm -rf / --no-preserve-root', 'deny', 'clean'],
  ['rm -rf node_modules || rm -rf /', 'deny', 'clean'],
  ['git push -f origin feature && tail -f log', 'ask', 'clean'],
  ['git push origin feature && tail -f log', 'allow', 'clean'],
  ['git push origin feature && rm -f x.log', 'allow', 'clean'],
  ['git push origin --delete old-branch', 'ask', 'clean'],
  ['git push origin :old-branch', 'ask', 'clean'],
  ['git push --force --dry-run origin main', 'allow', 'clean'],
  ['git -c core.sshCommand=ssh push --force origin main', 'deny', 'clean'],
  ['git push --force origin HEAD', 'deny', 'main'],
  ['git push -f origin', 'deny', 'main'],
  ['git push -f origin', 'ask', 'clean'],
  ['git push --force origin refs/heads/master', 'deny', 'clean'],
  ['aws s3 rm s3://bucket/ --recursive --dryrun', 'allow', 'clean'],
  ['grep -rn "truncate" src', 'allow', 'clean'],
  ['python3 -c "s=\'x\'; print(s[:10])  # truncate"', 'allow', 'clean'],
  ['grep -rn "DROP TABLE" tests/', 'allow', 'clean'],
  ['psql -c "TRUNCATE users"', 'ask', 'clean'],
  ['truncate -s 0 app.log', 'allow', 'clean'],
  ['git commit -m "drop table notes"', 'allow', 'clean'],
  ['git reflog expire --expire=now --all && git gc --prune=now', 'ask', 'clean'],
  ['git gc', 'allow', 'clean'],
  ['find /var/log -name \'*.gz\' -delete', 'ask', 'clean'],
  ['find . -name \'*.pyc\' -delete', 'allow', 'clean'],
  ['find /tmp -name \'x*\' -delete', 'allow', 'clean'],
  ['shred -u ~/.ssh/id_rsa', 'ask', 'clean'],
  ['unlink /etc/hosts', 'ask', 'clean'],
  ['rm -f /etc/hosts.bak', 'ask', 'clean'],
  ['rm -f ./tmp.log', 'allow', 'clean'],
  ['rm /tmp/x.log', 'allow', 'clean'],
  ['rm -f "$OUT"', 'ask', 'clean'],
  ['rm -f "${OUT:?}"', 'allow', 'clean'],
  ['git -C missing reset --hard', 'ask', 'clean'],
  ['cd /tmp && git reset --hard', 'ask', 'clean'],
  ['git stash && git reset --hard', 'ask', 'dirty'],
  ['git checkout -f main', 'ask', 'dirty'],
  ['git checkout -f main', 'allow', 'clean'],
  ['git switch --discard-changes main', 'allow', 'clean'],
  ['git switch --discard-changes main', 'ask', 'dirty'],
  ['git restore experiment-single.sh', 'ask', 'dirty'],
  ['git restore .gitignore', 'allow', 'dirty'],
  ['git reset --hard', 'ask', 'norepo'],
  ['git clean -fdx', 'ask', 'norepo'],
  ['git checkout -- README.md', 'ask', 'dirty'],
  ['git checkout -- .gitignore', 'allow', 'dirty'],
  ['git clean -fd -- config', 'allow', 'dirty'],
  ['terraform plan', 'allow', 'clean'],
  ['terraform apply -destroy -auto-approve', 'ask', 'clean'],
  ['helm uninstall myrelease', 'ask', 'clean'],
  ['gh repo delete me/x --yes', 'ask', 'clean'],
  ['redis-cli FLUSHALL', 'ask', 'clean'],
  ['docker system prune --volumes -f', 'ask', 'clean'],
  ['ls -la && git status', 'allow', 'clean'],
  ['(cd /tmp/build && make) && rm -rf src', 'ask', 'clean'],
  ['x=$(cd /tmp && pwd); rm -rf src', 'ask', 'clean'],
  ['cd /tmp/x; popd; rm -rf src', 'ask', 'clean'],
  ['cd /tmp/nope; rm -rf src', 'ask', 'clean'],
  ['cd /tmp/x || rm -rf src', 'ask', 'clean'],
  ['rm / -rf --no-preserve-root', 'deny', 'clean'],
  ['sudo rm ~ -r', 'deny', 'clean'],
  ['D=/tmp/x; D=src; rm -rf "$D"', 'ask', 'clean'],
  ['D=/srv/x; D=/srv/y; rm -f $D', 'ask', 'clean'],
  ['D=/srv/a; D=/srv/b; find $D -delete', 'ask', 'clean'],
  ['/usr/local/bin/rm -rf src', 'ask', 'clean'],
  ['/usr/bin/psql -c "DROP TABLE users"', 'ask', 'clean'],
  ['node -e "client.query(\'DROP TABLE users\')"', 'ask', 'clean'],
  ['npx wrangler d1 execute db --command="DROP TABLE users"', 'ask', 'clean'],
];

// GST-3190: the command-parsing gaps a second read found after #4513. Every row but the controls decided differently
// at 55aaa6c4; [item, command, expected, tree].
const PARSER_CASES: Array<[string, string, Decision, Tree]> = [
  ['force-push through --repo=', 'git push --repo=origin +refs/heads/main', 'deny', 'clean'],
  ['force-push through --repo=', 'git push --repo=origin --force main', 'deny', 'clean'],
  ['cd in a pipeline', 'cd /tmp | true && rm -rf relative-demo', 'ask', 'clean'],
  ['cd in a pipeline', 'true | cd /tmp && rm -rf relative-demo', 'ask', 'clean'],
  ['cd in a pipeline (control)', 'cd /tmp/x && make 2>&1 | tee log && rm -rf repro', 'allow', 'clean'],
  ['subshell gives back the scratch folder', 'cd /tmp && (pwd; pwd) && rm -rf relative-demo', 'allow', 'clean'],
  ['reset to a $ revision', 'git reset --hard "$REV"', 'ask', 'clean'],
  ['stash pop before a discard', 'git stash pop && git reset --hard', 'ask', 'clean'],
  ['own write before a discard (decided: allow)', 'printf "%s\\n" demo >> README.md && git reset --hard', 'allow', 'clean'],
  ['quiet git clean', 'git clean -fdxq', 'ask', 'dirty'],
  ['quiet git clean', 'git clean -fd --quiet', 'ask', 'dirty'],
  ['alternate git tree', 'GIT_DIR=.git git checkout -f main', 'ask', 'clean'],
  ['alternate git tree', 'git --work-tree=/tmp clean -fx', 'ask', 'clean'],
  ['find leading option', 'find -L /nonexistent/scratch-demo -delete', 'ask', 'clean'],
  ['rm trailing flags', 'rm relative-demo -rf', 'ask', 'clean'],
  ['rm trailing flags (control)', 'docker rm web -f', 'allow', 'clean'],
  ['mktemp variable reassigned', 'T=$(mktemp -d); T=/nonexistent/scratch-demo; rm -f "$T"', 'ask', 'clean'],
  ['.. traversal', 'rm -f /proc/../demo', 'ask', 'clean'],
  ['.. traversal', 'rm -rf ../build', 'ask', 'clean'],
  ['.. traversal', 'cd /tmp/../var && rm -rf relative-demo', 'ask', 'clean'],
  ['dry run in another statement', 'aws s3 rm s3://example-invalid/demo --recursive --dryrun; terraform destroy', 'ask', 'clean'],
  ['dry run in another statement', 'terraform destroy -var name=plan', 'ask', 'clean'],
  ['push dry run in a flag group', 'git push -nf origin main', 'allow', 'clean'],
  ['wipefs on a file (GST-3207: no image exemption)', 'wipefs -a demo.img', 'deny', 'clean'],
  ['wipefs on a file (control)', 'wipefs -a /dev/sdb', 'deny', 'clean'],
  ['SQL shape in a search or text', "grep 'truncate demo;' fixtures.sql", 'allow', 'clean'],
  ['SQL shape in a search or text', "echo 'truncate demo;'", 'allow', 'clean'],
  ['SQL shape in a search or text (control)', "echo 'TRUNCATE users;' | db-cli", 'ask', 'clean'],
  ['psql in a path', "grep 'DROP TABLE' ./psql/example.sql", 'allow', 'clean'],
  ['force-push after a cd', 'cd . && git push -f origin', 'deny', 'main'],
  ['force-push of every branch', 'git push --force --all origin', 'deny', 'clean'],
  ['force-push of every branch (control: no repository)', 'git push --force --all origin', 'ask', 'norepo'],
  ['second-model trail read: push option value', 'git push -onote --force origin main', 'deny', 'clean'],
  ['second-model trail read: wipefs on a device by another path', 'wipefs -a sda', 'deny', 'clean'],
  ['second-model trail read: wipefs on a device by another path', '/sbin/wipefs -af "$DISK"', 'deny', 'clean'],
  ['second-model trail read: dry-run text before the delete', 'FLAGS=--dryrun terraform destroy', 'ask', 'clean'],
  ['second-model trail read: || is not a pipe', "echo 'truncate demo;' || true", 'allow', 'clean'],
  ['review: dry run on the line before', 'aws s3 sync . s3://b --dryrun\naws s3 rb s3://prod --force', 'ask', 'clean'],
  ['review: dry run on the line before', 'aws s3 ls s3://b --dryrun;aws s3 rb s3://prod --force', 'ask', 'clean'],
  ['review: dry run on the line before', 'aws ec2 terminate-instances --instance-ids i-1 --dry-run\naws ec2 terminate-instances --instance-ids i-1', 'ask', 'clean'],
  ['review: SQL text sent to a file', "printf 'truncate users;' > q.sql && db-cli < q.sql", 'ask', 'clean'],
  ['review: quoted ; before a pipe', 'echo "TRUNCATE TABLE users;" | mycli prod', 'ask', 'clean'],
  ['round 2: cd after if', 'if cd B; then git clean -fdx; fi', 'ask', 'clean'],
  ['round 2: cd after while', 'while cd B; do git checkout -- .; break; done', 'ask', 'clean'],
  ['round 2: cd after time', 'time cd B && git reset --hard', 'ask', 'clean'],
  ['round 2: cd then a discard (control)', 'cd B && git clean -fdx', 'ask', 'clean'],
  ['round 2: an image suffix under /dev', 'wipefs -a /dev/sdb.img', 'deny', 'clean'],
  ['round 2: wipefs option values (GST-3207: no image exemption)', 'wipefs -t ext4 -a demo.img', 'deny', 'clean'],
  ['wipefs in the regex again: targets from xargs', 'ls /dev/sd* | xargs wipefs -a', 'deny', 'clean'],
  ['wipefs in the regex again: targets from stdin', 'echo /dev/sdb | xargs wipefs --all', 'deny', 'clean'],
  ['wipefs in the regex again: --a', 'wipefs --a /dev/sdb', 'deny', 'clean'],
  ['wipefs in the regex again: --al', 'wipefs --al /dev/sdb', 'deny', 'clean'],
  ['wipefs in the regex again: attached short option value', 'wipefs -a -tvfat /dev/sdb', 'deny', 'clean'],
  ['wipefs in the regex again: attached value in a group', 'wipefs -aftvfat /dev/sdb', 'deny', 'clean'],
  ['wipefs in the regex again: image suffix under /dev', 'wipefs --al /dev/sdb.img', 'deny', 'clean'],
  ['wipefs in the regex again: image names from xargs', 'ls *.img | xargs wipefs -a', 'deny', 'clean'],
  ['wipefs in the regex again: attached value on an image (GST-3207: no image exemption)', 'wipefs -a -tvfat demo.img', 'deny', 'clean'],
  ['wipefs in the regex again: several images (GST-3207: no image exemption)', 'wipefs --all disk.qcow2 build/b.iso', 'deny', 'clean'],
  ['wipefs round 2: an image name that is a symlink', 'wipefs -a alias.img', 'deny', 'clean'],
  ['wipefs round 2: a symlink made in the same command', 'ln -sf /dev/sdb d.img; wipefs -a d.img', 'deny', 'clean'],
  ['wipefs round 2: output redirected into a disk', 'wipefs -a demo.img > /dev/mmcblk0', 'deny', 'clean'],
  ['wipefs round 2: a quoted spelling beside a proven wipe', "wipefs -a demo.img; wi''pefs -a /dev/sdb", 'deny', 'clean'],
  ['wipefs round 2: errors sent to /dev/null (GST-3207: no image exemption)', 'wipefs -a demo.img 2>/dev/null', 'deny', 'clean'],
];

// GST-3207: the open notes left by #4521 and #4525, and the extra /tmp asks GEVA-560 measured at 55aaa6c4 (gap G14).
// Every row but the controls decided differently at 17303862; [item, command, expected, tree].
const FOLLOWUP_CASES: Array<[string, string, Decision, Tree]> = [
  ['wipefs: no image exemption', "wipefs -a demo.img >'/dev'/sdb", 'deny', 'clean'],
  ['wipefs: no image exemption', 'wipefs -a demo.img" #" /dev/sda', 'deny', 'clean'],
  ['wipefs: no image exemption', 'wipefs -a demo.img > devlink/sdb', 'deny', 'clean'],
  ['wipefs: no image exemption (control: without -a it only lists)', 'wipefs demo.img', 'allow', 'clean'],
  ['wipefs: a longer word is not wipefs', 'echo wipefs-archive', 'allow', 'clean'],
  ['wipefs: a longer word is not wipefs (control)', 'echo wipefs-archive && wipefs -a /dev/sdb', 'deny', 'clean'],
  ['wipefs: a backslash before the name', '\\wipefs -a /dev/sdb', 'deny', 'clean'],
  ['quoted /dev redirect', "echo hi >'/dev'/sdb", 'deny', 'clean'],
  ['quoted /dev redirect', 'echo hi > "/dev/mmcblk0"', 'deny', 'clean'],
  ['redirect through a folder that links to /dev', 'echo hi > devlink/sdb', 'deny', 'clean'],
  ['redirect through a folder that links to /dev (control: not a disk name)', 'echo hi > devlink/null', 'allow', 'clean'],
  ['redirect through a folder that links to /dev (control: a real folder)', 'echo hi > build/sdb', 'allow', 'clean'],
  ['quoted #', 'rm -rf "a #" ~', 'deny', 'clean'],
  ['quoted # (control: a real comment)', "rm -rf 'x' # ~", 'ask', 'clean'],
  ['quoted # (control: a real comment)', 'ls # rm -rf ~', 'allow', 'clean'],
  ['push dry run undone later', 'git push -fn --no-dry-run origin main', 'deny', 'clean'],
  ['push dry run undone later', 'git push --force -n --no-dry-run origin main', 'deny', 'clean'],
  ['push dry run undone later (control: the last flag wins)', 'git push --no-dry-run -fn origin main', 'allow', 'clean'],
  ['SQL text piped to a shell', "grep 'truncate users;' a.sql | sh", 'ask', 'clean'],
  ['SQL text into process substitution', "grep 'truncate users;' a.sql > >(sh)", 'ask', 'clean'],
  ['SQL text into process substitution', "grep -c ok <(dbtool exec 'TRUNCATE TABLE users')", 'ask', 'clean'],
  ['SQL text with git grep -O', "git grep -O 'truncate users;'", 'ask', 'clean'],
  ['SQL text with git grep -O', "git grep --open-files-in-pager=sh 'truncate users;'", 'ask', 'clean'],
  ['SQL text inside $( )', 'echo "$(dbtool exec \'TRUNCATE TABLE users\')"', 'ask', 'clean'],
  ['SQL text with a pipe in a later statement', "echo 'truncate demo;'; ls | wc -l", 'allow', 'clean'],
  ['SQL text with a quoted ;', "grep 'a; truncate demo;' fixtures.sql", 'allow', 'clean'],
  ['SQL text (control: search output to a pager)', "grep 'truncate demo;' fixtures.sql | head", 'allow', 'clean'],
  ['SQL text (control: not text)', 'mytool truncate users; ls', 'ask', 'clean'],
  ['LC_ALL=C cd (closed by #4525; pinned)', 'LC_ALL=C cd /tmp && rm -rf relative-demo', 'allow', 'clean'],
  ['scratch after a second cd', 'cd /tmp/x && cd sub && rm -rf relative-demo', 'allow', 'clean'],
  ['scratch after a second cd', 'T=$(mktemp -d) && cd "$T" && cd sub && rm -rf relative-demo', 'allow', 'clean'],
  ['scratch after a second cd (control: ..)', 'cd /tmp/x && cd ../.. && rm -rf relative-demo', 'ask', 'clean'],
  ['scratch after a second cd (control: a link made first)', 'cd /tmp/x && ln -s ~ s && cd s && rm -rf relative-demo', 'ask', 'clean'],
  ['scratch through a variable set to /tmp', 'W=/tmp/w && cd "$W" && rm -rf relative-demo', 'allow', 'clean'],
  ['scratch inside a subshell', 'cd /tmp/x && (make; rm -rf relative-demo)', 'allow', 'clean'],
  ['scratch inside a subshell (control: cd inside)', 'cd /tmp/x && (cd ~; rm -rf relative-demo)', 'ask', 'clean'],
  ['scratch inside a subshell (control: reached after ;)', 'cd /tmp/x; (rm -rf relative-demo)', 'ask', 'clean'],
  ['scratch inside a loop', 'cd /tmp/x && for f in a b; do rm -rf relative-demo; done', 'allow', 'clean'],
  ['scratch inside a loop', 'cd /tmp/x && if [ -d o ]; then rm -rf relative-demo; fi', 'allow', 'clean'],
  ['scratch inside a loop (control: cd in the body)', 'cd /tmp/x && for d in a b; do cd $d; rm -rf relative-demo; done', 'ask', 'clean'],
  ['scratch inside a loop (control: cd in a group)', 'cd /tmp/x && { cd ~; rm -rf relative-demo; }', 'ask', 'clean'],
  ['scratch inside a loop (control: after the loop)', 'cd /tmp/x && for f in a; do :; done; rm -rf relative-demo', 'ask', 'clean'],
  ['loop variable target', 'cd /tmp/x && for f in a b; do rm -rf "$f"; done', 'allow', 'clean'],
  ['loop variable target', 'for f in /tmp/a /tmp/b; do rm -rf $f; done', 'allow', 'clean'],
  ['loop variable target (control: not in scratch)', 'for f in a b; do rm -rf $f; done', 'ask', 'clean'],
  ['loop variable target (control: a path after it)', 'for f in a b; do rm -rf $f/; done', 'ask', 'clean'],
  ['loop variable target (control: a home word)', 'for f in ~ b; do rm -rf $f; done', 'ask', 'clean'],
  ['loop variable target (control: set elsewhere)', 'f=~; for f in a; do rm -rf $f; done', 'ask', 'clean'],
  ['reset after a cd to a known folder', 'D=. && cd "$D" && git reset -q --hard', 'allow', 'clean'],
  ['reset after a cd to a known folder', 'cd . && git reset -q --hard', 'allow', 'clean'],
  ['reset after a cd to a known folder (control: changes there)', 'D=. && cd "$D" && git reset -q --hard', 'ask', 'dirty'],
  ['reset after a cd to a known folder (control: unset variable)', 'cd $REPO && git reset -q --hard', 'ask', 'clean'],
  ['reset after a cd to a known folder (control: folder not there yet)', 'cd missing-demo && git reset -q --hard', 'ask', 'clean'],  ['heredoc written to a hook file', "cat > hooks/post-receive <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF", 'allow', 'clean'],
  ['heredoc written to a hook file', "cat > hooks/post-receive <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\nchmod +x hooks/post-receive", 'allow', 'clean'],
  ['heredoc written to a hook file', "tee deploy.sh <<'EOF' >/dev/null\ngit --work-tree=/srv checkout -f main\nEOF", 'allow', 'clean'],
  ['heredoc written to a hook file (control: the file is run)', "cat > hooks/post-receive <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\nbash hooks/post-receive", 'ask', 'clean'],
  ['heredoc written to a hook file (control: the file is run)', "cat > hooks/post-receive <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\nchmod +x hooks/post-receive && ./hooks/post-receive", 'ask', 'clean'],
  ['heredoc written to a hook file (control: a push runs the hook)', "cat > /git/p/hooks/post-receive <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\ncd /tmp/w && git push origin main", 'ask', 'clean'],
  ['heredoc written to a hook file (control: piped to a shell)', "cat <<'EOF' | sh\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF", 'ask', 'clean'],
  ['heredoc written to a hook file (control: run by bash)', "bash <<'EOF'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF", 'ask', 'clean'],
  ['heredoc written to a hook file (control: deletes still count)', "cat > hooks/x <<'EOF'\nrm -rf /var/www/old\nEOF", 'ask', 'clean'],
  ['heredoc written to a hook file (control: force-pushes still count)', "cat > hooks/x <<'EOF'\ngit push -f origin main\nEOF", 'deny', 'clean'],
  ['quoted /tmp path with a space (G16)', 'rm -rf "/tmp/scratch demo"', 'allow', 'clean'],
  ['quoted /tmp path with a space (control: a second target)', 'rm -rf "/tmp/a b" ~/x', 'ask', 'clean'],
  ['quoted /tmp path with a space (control: ..)', "rm -rf '/tmp/x y/../../etc'", 'ask', 'clean'],
  ['quoted /tmp path with a space (control: root word)', 'rm -rf "/ "', 'deny', 'clean'],
  ['loop variable target (control: used before the loop)', 'rm -rf $f; for f in /tmp/a; do :; done', 'ask', 'clean'],
  ['loop variable target (control: loop in a subshell)', '(for f in /tmp/a; do :; done); rm -rf $f', 'ask', 'clean'],
  ['loop variable target (control: loop may not run)', 'false && for f in /tmp/a; do :; done; rm -rf "$f"', 'ask', 'clean'],
  ['loop variable target (control: loop in the background)', 'for f in /tmp/a; do :; done & rm -rf $f', 'ask', 'clean'],
  ['loop variable target (control: a child shell reads it)', 'for f in /tmp/a; do bash -c "rm -rf \\$f"; done', 'ask', 'clean'],
  ['scratch through a variable set to /tmp (control: set after the cd)', 'cd "$W" && rm -rf relative-demo; W=/tmp/w', 'ask', 'clean'],
  ['scratch through a variable set to /tmp (control: a child shell reads it)', 'W=/tmp/w && bash -c \'cd $W && rm -rf relative-demo\'', 'ask', 'clean'],
  ['scratch after a second cd (control: CDPATH)', 'export CDPATH=/srv; cd /tmp/x && cd sub && rm -rf relative-demo', 'ask', 'clean'],
  ['reset after a cd to a known folder (control: set after the cd)', 'cd "$D" && git reset -q --hard; D=.', 'ask', 'clean'],
  ['reset after a cd to a known folder (control: CDPATH)', 'CDPATH=/srv; cd . && git reset -q --hard', 'ask', 'clean'],
  ['heredoc written to a hook file (control: unquoted body runs $( ))', 'cat > f <<EOF\n$(git reset --hard)\nEOF', 'ask', 'dirty'],
  ['heredoc written to a hook file (control: unquoted body runs a backtick)', 'cat > f <<EOF\n`git reset --hard`\nEOF', 'ask', 'dirty'],
  ['heredoc written to a hook file (unquoted body with no expansion)', 'cat > hooks/post-receive <<EOF\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF', 'allow', 'clean'],
  ['heredoc written to a hook file (control: partly quoted end word)', 'cat > f <<EO"F"\nx\nEOF\ngit reset --hard', 'ask', 'dirty'],
  ['heredoc written to a hook file (control: run by a quoted path)', 'cat > hooks/post-receive <<\'EOF\'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\nbash "hooks/post-receive"', 'ask', 'clean'],
  ['heredoc written to a hook file (control: run by a quoted path)', 'cat > hooks/post-receive <<\'EOF\'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\n\'./hooks/post-receive\'', 'ask', 'clean'],
  ['heredoc written to a hook file (control: fed to a shell)', 'cat > hooks/post-receive <<\'EOF\'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\nsh < hooks/post-receive', 'ask', 'clean'],
  ['heredoc written to a hook file (control: piped to a shell)', 'cat > hooks/post-receive <<\'EOF\'\nGIT_WORK_TREE=/var/www git checkout -f main\nEOF\ncat hooks/post-receive | sh', 'ask', 'clean'],
  ['quoted /tmp path with a space (control: quote closes mid-word)', 'rm "a b"c -r ~/x', 'ask', 'clean'],
  ['quoted /tmp path with a space (control: quote closes mid-word)', 'rm -rf "/tmp/a b"c ~', 'deny', 'clean'],
  ['SQL text (control: copied to another descriptor)', 'echo "TRUNCATE users;" >&3', 'ask', 'clean'],
  ['SQL text (control: copied to another descriptor)', 'echo "TRUNCATE users;" 1>&2', 'ask', 'clean'],
  ['SQL text (control: thrown away)', 'echo "truncate demo;" >/dev/null', 'allow', 'clean'],
  ['reset after a cd to a known folder (control: a quoted ~ is not expanded)', 'cd \'~\' && git reset -q --hard', 'ask', 'clean'],
  ['loop variable target (control: printf -v sets it)', 'for f in /tmp/a; do printf -v f %s ~; rm -rf $f; done', 'ask', 'clean'],
  ['loop variable target (control: a sourced file may set it)', 'for f in /tmp/a; do . ./e.sh; rm -rf $f; done', 'ask', 'clean'],
  ['loop variable target (control: a sourced file may set it)', 'for f in /tmp/a; do source e.sh; rm -rf $f; done', 'ask', 'clean'],
  ['SQL text (control: a file next to /dev/null)', 'echo "TRUNCATE users;" > "/dev/null x"', 'ask', 'clean'],
];

// GST-3207 review round at 12ad94a: ways the cd chain, a group's entry state, cd $NAME and the heredoc exemption could
// be wrong. Every row but the controls was allowed at 12ad94a and asked at 17303862; CLEAN and DIRTY name the trees.
const REVIEW_CASES: Array<[string, string, Decision, Tree]> = [
  ['a cd later in a loop body', 'cd /tmp/x && for d in a b; do rm -rf relative-demo; cd ~; done', 'ask', 'clean'],
  ['a cd later in a loop body', 'cd /tmp/x && while true; do rm -rf relative-demo; cd ~; done', 'ask', 'clean'],
  ['a cd later in a loop body', 'cd /tmp/x && for d in a b; do { rm -rf relative-demo; }; cd ~; done', 'ask', 'clean'],
  ['a cd later in a loop body (control: none)', 'cd /tmp/x && for d in a b; do rm -rf relative-demo; done', 'allow', 'clean'],
  ['a function that cds', 'f(){ cd ~; }; cd /tmp/x && { f; rm -rf relative-demo; }', 'ask', 'clean'],
  ['a function that cds', 'f(){ cd DIRTY; }; cd CLEAN && f && git reset --hard', 'ask', 'dirty'],
  ['a sourced file or eval that cds', 'cd CLEAN && source ./env.sh && git reset --hard', 'ask', 'dirty'],
  ['a sourced file or eval that cds', 'cd CLEAN && . ./env.sh && git reset --hard', 'ask', 'dirty'],
  ['a sourced file or eval that cds', 'cd CLEAN && eval "$GO" && git reset --hard', 'ask', 'dirty'],
  ['a group with no cd (control)', 'cd /tmp/x && { make; rm -rf relative-demo; }', 'allow', 'clean'],
  ['a quoted or backslashed cd', 'cd CLEAN && \\cd DIRTY && git reset --hard', 'ask', 'dirty'],
  ['a quoted or backslashed cd', 'cd CLEAN && c"d" DIRTY && git reset --hard', 'ask', 'dirty'],
  ['a quoted or backslashed cd', 'cd CLEAN && \\pushd DIRTY && git reset --hard', 'ask', 'dirty'],
  ['a quoted or backslashed cd (control: a plain cd)', 'cd CLEAN && git reset --hard', 'allow', 'dirty'],
  ['cd $NAME set again', 'T=/tmp/zz; read T < f; cd $T && rm -rf demo', 'ask', 'clean'],
  ['cd $NAME set again', 'T=/tmp/zz; printf -v T %s $HOME; cd $T && rm -rf demo', 'ask', 'clean'],
  ['cd $NAME set again', 'T=/tmp/zz; for T in $HOME/proj; do cd $T && rm -rf demo; done', 'ask', 'clean'],
  ['cd $NAME set again', 'R=CLEAN; for R in DIRTY; do cd $R && git checkout -f; done', 'ask', 'dirty'],
  ['cd $NAME set again', 'R=CLEAN; R+=/../dirty; cd $R && git reset --hard', 'ask', 'dirty'],
  ['cd $NAME set again (control: set once)', 'T=/tmp/zz; cd $T && rm -rf demo', 'allow', 'clean'],
  ['heredoc file run by a tool that does not name it', "cat > Makefile <<'EOF'\nall:\n\tgit reset --hard\nEOF\nmake", 'ask', 'dirty'],
  ['heredoc file run by a tool that does not name it', "cat > justfile <<'EOF'\nx:\n\tgit checkout -f main\nEOF\njust x", 'ask', 'dirty'],
  ['heredoc file run by a tool that does not name it', "cat > .git/hooks/pre-commit <<'EOF'\ngit reset --hard\nEOF\ngit commit -m x", 'ask', 'dirty'],
];

let base = '';
let scratch = '';
const trees = {} as Record<Tree, string>;

function makeTree(kind: Tree): string {
  const dir = path.join(base, kind);
  fs.mkdirSync(dir);
  if (kind === 'norepo') return dir;
  const git = (args: string[]) => {
    const r = gitArgvIn(dir, args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q', '-b', kind === 'main' ? 'main' : 'agent-work']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(dir, 'experiment-single.sh'), 'echo 1\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'config/local/\n');
  for (const image of ['demo.img', 'disk.qcow2', path.join('build', 'b.iso')]) {
    fs.mkdirSync(path.dirname(path.join(dir, image)), { recursive: true });
    fs.writeFileSync(path.join(dir, image), '');
  }
  fs.symlinkSync('/dev/null', path.join(dir, 'alias.img'));
  fs.symlinkSync('/dev', path.join(dir, 'devlink'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  if (kind !== 'main') git(['branch', 'main']);
  if (kind === 'dirty') {
    fs.appendFileSync(path.join(dir, 'README.md'), 'edit\n');
    fs.appendFileSync(path.join(dir, 'experiment-single.sh'), 'edit\n');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'new\n');
    fs.mkdirSync(path.join(dir, 'config', 'local'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'local', 'secrets.env'), 'K=1\n');
  }
  return dir;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-replay-'));
  fs.mkdirSync(path.join(base, 'home'));
  for (const kind of ['clean', 'dirty', 'main', 'norepo'] as Tree[]) trees[kind] = makeTree(kind);
  // A real scratch folder under /tmp holding a link out of it, for the second-cd symlink control.
  scratch = fs.mkdtempSync('/tmp/gstack-careful-scratch-');
  fs.mkdirSync(path.join(scratch, 'sub'));
  fs.symlinkSync(path.join(base, 'home'), path.join(scratch, 'out'));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

function decide(command: string, tree: Tree, tool = 'Bash'): { decision: Decision; reason: string } {
  const cwd = trees[tree];
  const r = spawnSync('bash', [CHECK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd, tool_input: { command } }),
    cwd,
    env: { ...process.env, HOME: path.join(base, 'home'), GIT_CEILING_DIRECTORIES: base },
    encoding: 'utf8',
    timeout: 25_000,
  });
  if (r.error || r.signal || r.status !== 0) throw new Error(`check-careful.sh failed (${r.status ?? r.signal ?? r.error?.message}): ${r.stderr}`);
  expect(r.stderr).toBe('');
  const out = JSON.parse(r.stdout.trim() || '{}').hookSpecificOutput ?? {};
  return { decision: out.permissionDecision ?? 'allow', reason: out.permissionDecisionReason ?? '' };
}

const rows: Row[] = fs.readFileSync(SYNTHETIC, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('GEVA-560 incident set', () => {
  test('is the set GEVA-560 measured, and every row has an expected decision', () => {
    expect(createHash('sha256').update(fs.readFileSync(SYNTHETIC)).digest('hex')).toBe(SYNTHETIC_SHA256);
    expect(rows).toHaveLength(102);
    expect(rows.map((r) => r.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(rows.map((r) => [r.id, r.label, r.fixture, EXPECTED[r.id], r] as const))(
    '%s (%s, %s tree) -> %s',
    (_id, _label, _tree, expected, row) => {
      expect(decide(row.command, row.fixture, row.tool).decision).toBe(expected);
    },
  );
});

describe('harmless scratch deletes no longer ask', () => {
  test.each(SCRATCH_DELETES)('%s', (command) => {
    expect(decide(command, 'clean')).toEqual({ decision: 'allow', reason: '' });
  });
});

describe('each new rule, with negative controls', () => {
  test.each(RULE_CASES)('%s -> %s (%s tree)', (command, expected, tree) => {
    expect(decide(command, tree).decision).toBe(expected);
  });

  test.each(PARSER_CASES)('%s: %s -> %s (%s tree)', (_item, command, expected, tree) => {
    expect(decide(command, tree).decision).toBe(expected);
  });

  test.each(FOLLOWUP_CASES)('%s: %s -> %s (%s tree)', (_item, command, expected, tree) => {
    expect(decide(command, tree).decision).toBe(expected);
  });

  test.each(REVIEW_CASES)('%s: %s -> %s (%s tree)', (_item, command, expected, tree) => {
    expect(decide(command.replaceAll('CLEAN', trees.clean).replaceAll('DIRTY', trees.dirty), tree).decision).toBe(expected);
  });

  test('a second cd from scratch counts only when no part of it below scratch is a symlink', () => {
    expect(decide('cd ' + scratch + ' && cd sub && rm -rf relative-demo', 'clean').decision).toBe('allow');
    expect(decide('cd ' + scratch + ' && cd out && rm -rf relative-demo', 'clean').decision).toBe('ask');
    expect(decide('cd ' + scratch + ' && cd out/x && rm -rf relative-demo', 'clean').decision).toBe('ask');
  });

  test('a 200 KB command is still checked well inside the guard hook\'s 8 s timeout', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `const x${i} = f(a, b) && (c || d); // ${i}`).join('\n');
    const started = Date.now();
    expect(decide(`cat > x.ts <<'EOF'\n${body}\nEOF\nrm -rf src`, 'clean').decision).toBe('ask');
    expect(Date.now() - started).toBeLessThan(6000);
  });
});
