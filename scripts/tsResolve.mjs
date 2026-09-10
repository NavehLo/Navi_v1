// A resolve hook so plain `node` can import the app's TypeScript modules.
//
// Node 24 strips types on its own, but it still resolves specifiers the ESM way
// and the app's imports are extensionless ('./perennialStreams'), the way
// TypeScript and Next expect them. This adds the extension back on the way
// through, which is the only thing standing between `node` and running the real
// source. Used by the check scripts here so they test the shipped module rather
// than a copy of it that could drift.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
      const candidate = resolvePath(base, specifier + ext);
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
