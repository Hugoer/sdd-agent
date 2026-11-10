// Exposes the local app through the developer's static ngrok domain.
// Run with `npm run tunnel` (loads .env). The ngrok authtoken stays in ngrok's own config.
import { spawn } from 'node:child_process';

const domain = process.env.NGROK_DOMAIN ?? '';
const port = process.env.PORT || '3000';

if (domain === '') {
  console.error(
    'NGROK_DOMAIN is not set in .env: claim your free static domain in the ngrok dashboard and set NGROK_DOMAIN to it (bare hostname).',
  );
  process.exit(1);
}

const ngrok = spawn('ngrok', ['http', `--url=${domain}`, port], {
  stdio: 'inherit',
});
ngrok.on('error', (error) => {
  console.error(
    error.code === 'ENOENT'
      ? 'ngrok CLI not found: install it (e.g. `brew install ngrok`) and run `ngrok config add-authtoken <token>`.'
      : `ngrok failed to start: ${error.message}`,
  );
  process.exit(1);
});
ngrok.on('exit', (code) => process.exit(code ?? 0));
