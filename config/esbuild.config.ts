import { rm } from 'fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import * as esbuild from 'esbuild';

await rm('./dist', { recursive: true, force: true });

// Build output path
const runIndex = './dist/index.js';

// Build entry
let commonOptions: esbuild.BuildOptions = {
  entryPoints: { index: 'src/index.ts' },
  outdir: './dist/',
  entryNames: '[name]',
  assetNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: false,
  minify: true,
};

/** Run the build output after a successful build; stop the old process before rebuilding */
function createRestartOnRebuildPlugin(entries: string[]): esbuild.Plugin {
  let child: ChildProcess | undefined;

  const stop = () => {
    child?.kill();
    child = undefined;
  };

  // When node --watch restarts the config process, clean up the child process too
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('exit', stop);

  return {
    name: 'run-after-build',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        stop();
        child = spawn(process.execPath, entries, { stdio: 'inherit', env: process.env });
      });
    },
  };
}

if (process.argv.includes('--dev')) {
  commonOptions = {
    ...commonOptions,
    sourcemap: true,
    minify: false,
    // ESM has no global require; bundled dependencies (such as ws) use esbuild's
    // __require shim, so createRequire must be injected or the runtime fails with
    // Dynamic require of "net" is not supported.
    banner: {
      js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
    },
    plugins: [createRestartOnRebuildPlugin([runIndex])],
  };
  const ctx = await esbuild.context(commonOptions);
  await ctx.watch({ delay: 500 });
  console.log('Watching for changes...');
} else {
  await esbuild.build(commonOptions);
}
