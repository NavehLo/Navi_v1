import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const config = {
  plugins: {
    // `base` pinned to this directory. Left to itself the plugin resolves
    // `@import "tailwindcss"` from the inferred workspace root, which here is
    // the parent folder — it holds an older standalone copy of this app, has no
    // node_modules, and produced "Can't resolve 'tailwindcss'" on every dev
    // compile while `next build` worked fine.
    "@tailwindcss/postcss": { base: here },
  },
};

export default config;
