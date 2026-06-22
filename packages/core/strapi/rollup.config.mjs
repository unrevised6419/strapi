import { baseConfig } from '../../../rollup.utils.mjs';

export default baseConfig({
  input: {
    index: './src/index.ts',
    cli: './src/cli/index.ts',
    admin: './src/admin.ts',
    'admin-test': './src/admin-test.ts',
    // Phase C (experimental): the prod `server` env build resolves this file as
    // its Rolldown `rollupOptions.input`, so it must ship as a real dist file
    // (not be tree-shaken into another chunk).
    'node/server-prod-entry': './src/node/server-prod-entry.ts',
  },
});
