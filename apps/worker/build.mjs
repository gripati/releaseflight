/**
 * esbuild bundle script for @marquee/worker.
 *
 * Strategy:
 *   - Bundle ALL first-party @marquee/* workspace packages inline (they are
 *     TS-only, no compiled output, so the bundler must inline them).
 *   - Externalize ALL real node_modules (bullmq, ioredis, @prisma/client, etc.)
 *     and all node: built-ins — they stay in node_modules and load at runtime.
 *   - Output: dist/index.cjs (CommonJS, even though the repo is ESM, because
 *     .cjs extension forces CJS loader regardless of package.json "type":"module",
 *     giving clean interop with Prisma's CJS engines and BullMQ's CJS internals).
 *   - No source maps, no comments, minified — the dist file ships in the image
 *     and must not leak original source structure.
 *
 * Go regex note (esbuild filter): esbuild passes filter patterns to Go's regexp
 * engine, which does NOT support lookahead assertions.
 *
 * Approach: we use a single onResolve rule with a filter that matches all bare
 * specifiers (non-relative, non-absolute), then inside the callback we check
 * whether it's a @marquee/ workspace package and selectively externalize.
 * The filter /^[^./]/ matches any specifier that does not start with . or /,
 * which covers: node:*, @scope/pkg, plain-pkg. We then return external:true
 * only for non-@marquee paths.
 */

import { build } from "esbuild";

/** Plugin: bundle @marquee/* in, externalize everything else bare. */
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(b) {
    // Match ALL bare specifiers (not relative ./.. or absolute /).
    // Inside, only mark external if it is NOT a first-party @marquee package.
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@marquee/")) {
        // First-party workspace package — let esbuild resolve it normally
        // (follows the workspace symlink into packages/<name>/src/index.ts).
        return undefined;
      }
      // Third-party package or node: builtin — externalize.
      return { external: true };
    });
  },
};

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  platform: "node",
  target: "node22",
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  format: "cjs",
  // In CJS output, import.meta.url is unavailable. Define it as the CJS
  // equivalent (__filename as a file URL) so env.ts's best-effort .env loader
  // resolves the monorepo root correctly.
  // In Docker, env vars are injected directly and the try/catch in env.ts
  // swallows any path error — so this is belt-and-suspenders.
  define: {
    "import.meta.url": "__importMetaUrl",
  },
  banner: {
    js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  plugins: [externalizeThirdParty],
});

console.log("Worker bundle written to dist/index.cjs");
