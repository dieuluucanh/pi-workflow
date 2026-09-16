// Type declarations for untyped packages
//
// `typebox` ships a `types` field pointing at `build/index.d.mts` but its
// `exports` map has no `"types"` condition. TypeScript's NodeNext resolver
// (used by this package's tsconfig, and by `npm run typecheck`) finds the real
// declaration by extension substitution; resolvers that fall back to the
// `.mjs` report TS7016. The shorthand below keeps those resolvers quiet — it
// only applies when the module is otherwise unresolved, so the real typebox
// types are still used where they resolve.
declare module "typebox";
declare module "chrome-remote-interface";
