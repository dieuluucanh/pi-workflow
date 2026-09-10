---
name: server-logs
description: Inspect Docker containers and systemd services on a remote VPS over SSH, or locally. Use when debugging deployed apps, checking container health, or reading service logs.
---

# Server Logs

Lets the AI agent read logs from Docker containers and systemd services on a remote server (via SSH) or the local machine.

## When to use

- "Show me the logs for the api container"
- "Why is the worker crashing? Check its logs since 10 minutes ago"
- "List all running containers on the server"
- "Get the last 50 lines of the nginx journal"
- "Check the compose logs for the web service"

## Setup

### Remote VPS (SSH)

```bash
pi -e ./server-logs/index.ts --ssh user@host
```

With a specific remote working directory:

```bash
pi -e ./server-logs/index.ts --ssh user@host:/path/to/project
```

**Requirements:**

- SSH key-based auth (no password prompts)
- `docker` CLI on the target (for docker tools)
- `systemd`/`journalctl` on the target (for journal tool)

### Local Docker

```bash
pi -e ./server-logs/index.ts
```

Works without `--ssh` — runs against your local Docker socket.

## Tools

| Tool | Purpose |
| ------ | --------- |
| `docker_logs` | Fetch logs from a container (tail, since, filter, timestamps) |
| `docker_ps` | List containers (running or all) |
| `docker_services` | Fetch Docker Compose logs for a project |
| `server_journal` | Fetch systemd journal entries for a unit |

## Examples

```javascript
// List containers
docker_ps: { all: true }

// Get last 100 lines from the api container
docker_logs: { container: "myproject-api-1", lines: 100 }

// Errors in the last 30 minutes
docker_logs: { container: "worker", since: "30m", filter: "ERROR" }

// Compose logs for specific services
docker_services: { project: "myproject", services: "api worker", lines: 50 }

// Systemd journal
server_journal: { unit: "nginx", lines: 100, since: "1 hour ago" }
```

## Notes

- Output is capped at 50,000 characters to avoid flooding the model context. Truncation is reported.
- Secrets (Bearer tokens, API keys, passwords) are automatically redacted before reaching the model.
- If Docker isn't available on the target, docker tools return a clear message instead of throwing.
