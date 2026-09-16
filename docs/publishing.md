# Pi Extensions — Publishing & Development Guide

Step-by-step guide for publishing, installing, and developing the four Pi extensions in this repository.

---

## Table of Contents

- [Packages Overview](#packages-overview)
- [Prerequisites](#prerequisites)
- [Production: Publish to npm](#production-publish-to-npm)
- [Production: Install via pi](#production-install-via-pi)
- [Development: Local setup](#development-local-setup)
- [Development: Testing changes](#development-testing-changes)
- [Versioning](#versioning)
- [Troubleshooting](#troubleshooting)

---

## Packages Overview

| Package | npm name | Description |
| --------- | ---------- | ------------- |
| workflow | `@dieulc/workflow` | Plan↔Build mode, questionnaire, subagent explore, todos, checkpoint rewind |
| autocompact | `@dieulc/autocompact` | Intelligent session context compaction, plan/todo-aware summarization |
| server-logs | `@dieulc/server-logs` | Docker & systemd log inspection tools (remote SSH or local) |
| browser-inspector | `@dieulc/browser-inspector` | Browser DevTools inspection via CDP (console, network, performance) |

---

## Prerequisites

- Node.js ≥ 20
- npm CLI (logged in: `npm login`)
- Pi CLI installed (`npm i -g @earendil-works/pi-coding-agent`)

Verify npm login:

```bash
npm whoami
# should print: dieulc
```

---

## Production: Publish to npm

Run these from the **repository root** (`C:/Users/Lenovo/.pi`).

### Dry run (verify tarball contents without publishing)

```bash
# workflow
cd agent/extensions/workflow && npm pack --dry-run && cd ../../..

# autocompact
cd agent/extensions/autocompact && npm pack --dry-run && cd ../../..

# server-logs
cd agent/extensions/server-logs && npm pack --dry-run && cd ../../..

# browser-inspector
cd agent/extensions/browser-inspector && npm pack --dry-run && cd ../../..
```

Check the output — verify `files` list includes the right `.ts`/`.md` files and excludes tests/build artifacts.

### Publish (all four)

```bash
# 1. @dieulc/workflow
cd agent/extensions/workflow && npm publish --access public && cd ../../..

# 2. @dieulc/autocompact
cd agent/extensions/autocompact && npm publish --access public && cd ../../..

# 3. @dieulc/server-logs
cd agent/extensions/server-logs && npm publish --access public && cd ../../..

# 4. @dieulc/browser-inspector
cd agent/extensions/browser-inspector && npm publish --access public && cd ../../..
```

> `--access public` is required for scoped `@dieulc/*` packages on first publish.

### One-liner (all four in sequence)

```bash
for dir in workflow autocompact server-logs browser-inspector; do \
  echo "--- Publishing @dieulc/$dir ---" && \
  cd agent/extensions/$dir && npm publish --access public && cd ../../..; \
done
```

### Verify on npm

```bash
npm view @dieulc/workflow
npm view @dieulc/autocompact
npm view @dieulc/server-logs
npm view @dieulc/browser-inspector
```

---

## Production: Install via pi

End users install with the Pi CLI:

```bash
# Individual packages
pi install npm:@dieulc/workflow
pi install npm:@dieulc/autocompact
pi install npm:@dieulc/server-logs
pi install npm:@dieulc/browser-inspector

# All at once
pi install npm:@dieulc/workflow npm:@dieulc/autocompact npm:@dieulc/server-logs npm:@dieulc/browser-inspector
```

Pinned version (recommended for stability):

```bash
pi install npm:@dieulc/workflow@0.1.0
```

Manage installed packages:

```bash
pi list                     # show installed packages
pi update --extensions      # update all packages
pi update npm:@dieulc/workflow  # update one package
pi remove npm:@dieulc/workflow  # uninstall
```

---

## Development: Local setup

### Clone and link (for active development)

```bash
# From anywhere — clone the repo
git clone https://github.com/dieuluucanh/pi-workflow.git ~/.pi

# The extensions are auto-discovered from:
#   ~/.pi/agent/extensions/workflow/index.ts
#   ~/.pi/agent/extensions/autocompact/extensions/autocompact.ts
#   ~/.pi/agent/extensions/server-logs/index.ts
#   ~/.pi/agent/extensions/browser-inspector/src/index.ts
```

### Local override via settings (without cloning into ~/.pi)

If your extensions live elsewhere, point pi to them in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/pi-workflow/agent/extensions/workflow",
    "/path/to/pi-workflow/agent/extensions/autocompact",
    "/path/to/pi-workflow/agent/extensions/server-logs",
    "/path/to/pi-workflow/agent/extensions/browser-inspector"
  ]
}
```

Or use the `-e` flag for a one-off test:

```bash
pi -e ./agent/extensions/workflow/index.ts
pi -e ./agent/extensions/server-logs/index.ts
```

### Install dependencies (browser-inspector only)

`browser-inspector` has npm dependencies that must be installed:

```bash
cd agent/extensions/browser-inspector && npm install
```

The other three extensions have no runtime dependencies (only `peerDependencies` for pi internals).

---

## Development: Testing changes

### Type-check

```bash
cd agent/extensions/workflow && npx tsc --noEmit -p tsconfig.json
cd agent/extensions/autocompact && npx tsc --noEmit -p tsconfig.json
cd agent/extensions/server-logs && npx tsc --noEmit
```

### Run tests

```bash
cd agent/extensions/workflow && npm test
```

### Hot reload in pi

Extensions in `~/.pi/agent/extensions/` are hot-reloadable:

```
/reload
```

This reloads all extensions without restarting pi.

### Quick iteration cycle

1. Edit the `.ts` file
2. In pi, run `/reload`
3. Test the behavior
4. Repeat

---

## Versioning

Follow semver. For pre-1.0 packages, breaking changes bump minor:

```bash
# Patch (bug fix)
cd agent/extensions/workflow && npm version patch && npm publish --access public

# Minor (new feature, backward-compatible)
cd agent/extensions/workflow && npm version minor && npm publish --access public

# Major (breaking change)
cd agent/extensions/workflow && npm version major && npm publish --access public
```

Update all four together:

```bash
for dir in workflow autocompact server-logs browser-inspector; do \
  cd agent/extensions/$dir && npm version patch && cd ../../..; \
done

for dir in workflow autocompact server-logs browser-inspector; do \
  cd agent/extensions/$dir && npm publish --access public && cd ../../..; \
done
```

---

## Troubleshooting

### `npm publish` fails with 403

- Ensure `npm whoami` returns `dieulc`
- Ensure the package name matches the npm scope you own
- First publish of a scoped package requires `--access public`

### Extension not loading in pi

- Check the file is in a trusted location (`~/.pi/agent/extensions/`)
- Run `/reload` after adding/editing
- Check pi logs for import errors: `pi --verbose`

### `tsc` type errors

- Ensure `peerDependencies` are satisfied — pi bundles `@earendil-works/*` and `typebox` at runtime
- For local dev, install dev deps: `npm install` in the extension directory

### browser-inspector CDP connection issues

- Requires `chrome-launcher` and `chrome-remote-interface` — run `npm install` first
- Chrome must be launched with `--remote-debugging-port` or via the extension's launcher

---

## File Structure Reference

```
~/.pi/                                    # repo root (or any clone location)
├── package.json                          # root meta-package (not published)
├── agent/extensions/
│   ├── workflow/
│   │   ├── package.json                  # @dieulc/workflow
│   │   ├── index.ts                      # entry point
│   │   ├── utils.ts                      # todo extraction, plan parsing
│   │   ├── checkpoint.ts                 # git shadow checkpoint
│   │   ├── roles.ts                      # plan/build mode roles
│   │   └── utils.todo.test.ts            # tests
│   ├── autocompact/
│   │   ├── package.json                  # @dieulc/autocompact
│   │   ├── extensions/autocompact.ts     # entry point
│   │   └── prompts/autocompact-summary.md
│   ├── server-logs/
│   │   ├── package.json                  # @dieulc/server-logs
│   │   ├── index.ts                      # entry point (docker/systemd tools)
│   │   └── SKILL.md                      # companion skill docs
│   └── browser-inspector/
│       ├── package.json                  # @dieulc/browser-inspector
│       ├── src/index.ts                  # entry point (CDP tools)
│       └── extension/                    # chrome extension files
│           ├── background.js
│           └── panel.js
```
