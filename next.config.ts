import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root to this directory.
    //
    // Turbopack infers the root by walking up from the project, and the parent
    // directory here holds an older standalone version of this app (its own
    // .git, index.html and sw.js). Turbopack picked that as the root, then
    // tried to resolve `tailwindcss` from it — where there is no node_modules —
    // and `next dev` exited before ever answering on the port, with
    // "Can't resolve 'tailwindcss'". `next build` was unaffected, which is what
    // made it look like a dev-server bug rather than a resolution one.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
