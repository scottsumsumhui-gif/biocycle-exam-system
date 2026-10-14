// Push 用 GCM（Windows 已 cache 憑證）。
// 2026-09-16 已移走 system gitconfig 嘅 credential.helper=helper-selector（CredentialHelperSelector 彈框元兇），
// 所以直接用 global 嘅 GCM 就得，唔需要再 override credential.helper。
const { spawn, execSync } = require('child_process');
try { execSync('taskkill /F /IM git.exe /T', { stdio: 'ignore' }); } catch (e) { }
try { execSync('taskkill /F /IM git-credential-manager.exe /T', { stdio: 'ignore' }); } catch (e) { }

const GIT = 'C:\\Users\\Sum\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\cmd\\git.exe';
const GCM = 'C:\\Users\\Sum\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\mingw64\\bin\\git-credential-manager.exe';
const DIR = 'C:\\Users\\Sum\\WorkBuddy\\2026-06-28-22-52-03\\exam-system';
const args = process.argv.slice(2);
if (!args.length) args.push('push', 'origin', 'HEAD:refs/heads/main');

const env = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never'
});

const p = spawn(GIT, ['-C', DIR].concat(args), { env });
p.stdout.on('data', d => process.stdout.write(d));
p.stderr.on('data', d => process.stdout.write('[E] ' + d));
const t = setTimeout(() => {
  console.log('\n[TIMEOUT 180s] -> kill');
  try { p.kill('SIGKILL'); } catch (e) { }
  try { execSync('taskkill /F /IM git.exe /T', { stdio: 'ignore' }); } catch (e) { }
  process.exit(0);
}, 180000);
p.on('exit', c => { clearTimeout(t); console.log('\nEXIT=' + c); process.exit(0); });
