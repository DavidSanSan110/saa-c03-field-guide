import { z } from 'zod';

// Zod probes Function('') to decide whether to JIT-compile object schemas, which a CSP without
// 'unsafe-eval' reports as a violation. Imported first by index.ts, so it runs before any schema is built.
z.config({ jitless: true });
