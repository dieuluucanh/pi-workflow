# @dieulc/server-logs

Pi extension that lets the agent inspect **Docker containers** and **systemd services** on a remote VPS over SSH — or on the local machine.

[![pi-package](https://img.shields.io/badge/pi--package-blue)](https://pi.dev/packages)

## Install

```bash
pi install npm:@dieulc/server-logs          # latest
pi install npm:@dieulc/server-logs@0.1.0    # pinned
pi install -l npm:@dieulc/server-logs       # project-local (.pi/settings.json)
pi -e npm:@dieulc/server-logs               # try without installing
```

Manage it with `pi list`, `pi update --extensions`, `pi remove npm:@dieulc/server-logs`.

## Setup

### Remote VPS (SSH)

```bash
pi --ssh user@host
```

With a specific remote working directory:

```bash
pi --ssh user@host:/path/to/project
```

**Requirements:**

- SSH key-based auth (no password prompts)
- `docker` CLI on the target (for the docker tools)
- `systemd`/`journalctl` on the target (for the journal tool)

### Local Docker

```bash
pi
```

Works without `--ssh` — tools run against your local Docker socket.

## Tools

| Tool | Purpose |
| --- | --- |
| `docker_logs` | Fetch logs from a container (tail, since, filter, timestamps) |
| `docker_ps` | List containers (running or all) |
| `docker_services` | Fetch Docker Compose logs for a project |
| `server_journal` | Fetch systemd journal entries for a unit |

## Examples

```javascript
// List containers
docker_ps: { all: true }

// Last 100 lines from the api container
docker_logs: { container: "myproject-api-1", lines: 100 }

// Errors in the last 30 minutes
docker_logs: { container: "worker", since: "30m", filter: "ERROR" }

// Compose logs for specific services
docker_services: { project: "myproject", services: "api worker", lines: 50 }

// systemd journal
server_journal: { unit: "nginx", lines: 100, since: "1 hour ago" }
```

## Notes

- Output is capped at 50,000 characters to avoid flooding the model context. Truncation is reported.
- Secrets (Bearer tokens, API keys, passwords) are automatically redacted before reaching the model.
- If Docker isn't available on the target, the docker tools return a clear message instead of throwing.

## Development

```bash
cd agent/extensions/server-logs
npm install
npm run typecheck
```

The extension is plain TypeScript with no build step — Pi loads `index.ts` directly. For a live check:

```bash
pi -e ./index.ts
```

## License

MIT — see [LICENSE](./LICENSE).
