import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const LOCAL_H3_TOKEN = 'kaishi-local-h3';
const decrypt = encrypted => new Promise((resolve, reject) => {
  const script = '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
  const executable = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PSModulePath: join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') },
  });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', part => { output += part; });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('无法读取本机 H3 凭据')));
  child.stdin.end(encrypted);
});

export function h3Credentials(root) {
  const destination = join(root, '.local', 'h3-credentials.dpapi.json');
  const legacy = join(homedir(), 'Desktop', 'minimax', '.agent-canvas', 'credentials.dpapi.json');
  let cached = '';
  const readEncrypted = async path => {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return typeof data?.values?.compshare === 'string' ? data.values.compshare : '';
  };
  return {
    async importLegacy() {
      if (process.platform !== 'win32' || process.env.KAISHI_RUNTIME_FILE) return false;
      let value;
      try { value = await readEncrypted(destination); } catch { value = ''; }
      if (!value) { try { value = await readEncrypted(legacy); } catch { return false; } }
      if (!value) return false;
      try { cached = await decrypt(value); } catch { return false; }
      if (!cached.startsWith('sk-ml-')) { cached = ''; return false; }
      await mkdir(join(root, '.local'), { recursive: true });
      await writeFile(destination, JSON.stringify({ version: 1, values: { compshare: value } }), { mode: 0o600 });
      return true;
    },
    async get() {
      if (!cached) cached = await decrypt(await readEncrypted(destination));
      if (!cached.startsWith('sk-ml-')) throw new Error('本机 H3 凭据不可用');
      return cached;
    },
  };
}
