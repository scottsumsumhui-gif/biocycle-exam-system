// 診斷 git push 卡住嘅位置（帶 GIT_TRACE，45 秒自動中止）
const { spawn, execSync } = require('child_process');
try { execSync('taskkill /F /IM git.exe /T', { stdio: 'ignore' }); } catch (e) { }
try { execSync('taskkill /F /IM git-credential-manager.exe /T', { stdio: 'ignore' }); } catch (e) { }

const GIT = 'C:\\Users\\Sum\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\cmd\\git.exe';
const DIR = 'C:\\Users\\Sum\\WorkBuddy\\2026-06-28-22-52-03\\exam-system';
const args = process.argv.slice(2);
if (!args.length) args.push('push', 'origin', 'HEAD:refs/heads/main');

const p = spawn(GIT, ['-C', DIR].concat(args), {
  env: Object.assign({}, process.env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_TRACE: '1',
    GIT_TRACE_CURL: '1'
  })
});
let out = '';
p.stdout.on('data', d => { out += d; process.stdout.write(d); });
p.stderr.on('data', d => { out += d; process.stdout.write('[E] ' + d); });
const t = setTimeout(() => {
  console.log('\n[TIMEOUT 45s] -> kill');
  try { p.kill('SIGKILL'); } catch (e) { }
  try { execSync('taskkill /F /IM git.exe /T', { stdio: 'ignore' }); } catch (e) { }
  process.exit(0);
}, 45000);
p.on('exit', c => { clearTimeout(t); console.log('\nEXIT=' + c); process.exit(0); });
