import { spawn } from 'node:child_process';

async function hiddenInput(label) {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or supply keys through the process environment.');
  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function finish() { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
    function onData(data) {
      for (const character of data) {
        if (character === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value.trim()); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    }
    process.stdin.on('data', onData);
  });
}
try {
  const sarvam = process.env.SARVAM_API_KEY || await hiddenInput('Sarvam API key (hidden)');
  const ollama = process.env.OLLAMA_API_KEY || await hiddenInput('Ollama API key (hidden)');
  if (!sarvam || !ollama) throw new Error('Both keys are required.');
  const child = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: { ...process.env, SARVAM_API_KEY: sarvam, OLLAMA_API_KEY: ollama } });
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', () => { console.error('Could not start the voice server.'); process.exit(1); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
