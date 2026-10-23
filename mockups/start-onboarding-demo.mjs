import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Serve the existing renderer through Vite. No build, desktop backend, wallet,
// Electron IPC, or production entry point is involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5181, strictPort: true } });
await server.listen();
console.log('\nReal UI onboarding demo: http://127.0.0.1:5181/mockups/onboarding-concepts.html\n');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
