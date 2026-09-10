/**
 * Server Logs Extension
 *
 * Lets the AI agent inspect Docker containers and systemd services on a
 * remote VPS over SSH (or locally when no --ssh flag is given).
 *
 * Tools: docker_logs, docker_ps, docker_services, server_journal
 *
 * Usage:
 *   pi -e ./server-logs/index.ts --ssh user@host
 *   pi -e ./server-logs/index.ts --ssh user@host:/remote/path
 *   pi -e ./server-logs/index.ts                      # local Docker
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts) when --ssh is used
 *   - docker CLI on the target
 */

import { spawn } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration state (resolved lazily on session_start, matching ssh.ts)
// ---------------------------------------------------------------------------

interface SshConfig {
	remote: string;
	remoteCwd: string;
}

let sshConfig: SshConfig | null = null;

// ---------------------------------------------------------------------------
// Execution backend: routes through SSH when configured, else runs locally
// ---------------------------------------------------------------------------

interface ExecOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number; // seconds
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => errChunks.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(
						`SSH command failed (${code}): ${Buffer.concat(errChunks).toString()}`,
					),
				);
			}
		});
	});
}

/**
 * Execute a command — remotely via SSH when --ssh is set, otherwise locally.
 * Supports streaming via onData, abort via signal, and timeout.
 */
function execCommand(
	command: string,
	cwd: string,
	opts: ExecOptions = {},
): Promise<ExecResult> {
	const useSsh = sshConfig !== null;
	const fullCommand = useSsh
		? `cd ${JSON.stringify(sshConfig.remoteCwd)} && ${command}`
		: command;

	return new Promise((resolve, reject) => {
		const child = useSsh
			? spawn("ssh", [sshConfig!.remote, fullCommand], {
					stdio: ["ignore", "pipe", "pipe"],
				})
			: spawn("bash", ["-c", `cd ${JSON.stringify(cwd)} && ${command}`], {
					stdio: ["ignore", "pipe", "pipe"],
				});

		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let timedOut = false;

		child.stdout.on("data", (d) => {
			chunks.push(d);
			opts.onData?.(d);
		});
		child.stderr.on("data", (d) => {
			errChunks.push(d);
			opts.onData?.(d);
		});

		const timer = opts.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, opts.timeout * 1000)
			: undefined;

		const onAbort = () => child.kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			reject(e);
		});

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) {
				reject(new Error("aborted"));
			} else if (timedOut) {
				reject(new Error(`timeout:${opts.timeout}`));
			} else {
				resolve({
					stdout: Buffer.concat(chunks).toString(),
					stderr: Buffer.concat(errChunks).toString(),
					exitCode: code,
				});
			}
		});
	});
}

/** Detect whether docker is available on the target. */
async function detectDocker(): Promise<boolean> {
	try {
		await execCommand("docker --version", process.cwd());
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Output safety: cap + truncate to avoid flooding the LLM context
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 50_000;

/** Patterns that look like secrets — replaced before the text reaches the model. */
const SECRET_PATTERNS: RegExp[] = [
	/(Bearer\s+)[A-Za-z0-9._-]+/g,
	/(token|api[_-]?key|apikey|password|secret|Authorization)["':=\s]+[A-Za-z0-9._-]{8,}/gi,
	/(sk-[A-Za-z0-9]{20,})/g,
	/(gh[pousr]_[A-Za-z0-9]{36,})/g,
	/(xox[baprs]-[A-Za-z0-9-]+)/g,
];

function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, "$1<REDACTED>");
	}
	return result;
}

function safeOutput(text: string): { text: string; truncated: boolean } {
	const redacted = redactSecrets(text);
	if (redacted.length <= MAX_OUTPUT_CHARS)
		return { text: redacted, truncated: false };
	const head = redacted.slice(0, MAX_OUTPUT_CHARS);
	return {
		text:
			head +
			`\n\n--- OUTPUT TRUNCATED (${text.length} chars total, showing first ${MAX_OUTPUT_CHARS}) ---`,
		truncated: true,
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", {
		description: "SSH remote for server logs: user@host or user@host:/path",
		type: "string",
	});

	let dockerAvailable = false;

	// ---- docker_logs ---------------------------------------------------------
	pi.registerTool({
		name: "docker_logs",
		label: "Docker Logs",
		description:
			"Fetch logs from a Docker container. Use container name or ID. Supports tailing, time-based filtering (since), text filtering (grep), and timestamps.",
		parameters: Type.Object({
			container: Type.String({ description: "Container name or ID" }),
			lines: Type.Optional(
				Type.Number({
					description: "Number of lines to fetch from the end (default 100)",
					default: 100,
				}),
			),
			since: Type.Optional(
				Type.String({
					description:
						'Only return logs since a duration like "30m", "2h", or "2024-01-01"',
				}),
			),
			filter: Type.Optional(
				Type.String({ description: "Only return lines matching this text (grep)" }),
			),
			timestamps: Type.Optional(
				Type.Boolean({
					description: "Include timestamps in output",
					default: false,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!dockerAvailable) {
				return {
					content: [
						{
							type: "text",
							text:
								"Docker is not available on the target. Ensure Docker is installed and the user has permissions.",
						},
					],
					details: { error: "docker-unavailable" },
				};
			}

			const parts = ["docker logs", "--tail", String(params.lines ?? 100)];
			if (params.since) parts.push("--since", params.since);
			if (params.timestamps) parts.push("-t");
			parts.push(params.container);

			let cmd = parts.join(" ");
			if (params.filter) {
				cmd += ` | grep ${JSON.stringify(params.filter)}`;
			}

			try {
				const { text } = safeOutput(
					(await execCommand(cmd, ctx.cwd, { signal })).stdout,
				);
				return {
					content: [{ type: "text", text: text || "(no log output)" }],
					details: {
						container: params.container,
						truncated: text.length >= MAX_OUTPUT_CHARS,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch logs for "${params.container}": ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- docker_ps -----------------------------------------------------------
	pi.registerTool({
		name: "docker_ps",
		label: "Docker PS",
		description:
			"List Docker containers on the target. Shows container IDs, names, status, and ports.",
		parameters: Type.Object({
			all: Type.Optional(
				Type.Boolean({
					description: "Show all containers including stopped ones",
					default: false,
				}),
			),
			filter: Type.Optional(
				Type.String({ description: "Filter by name (docker ps --filter)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!dockerAvailable) {
				return {
					content: [
						{
							type: "text",
							text: "Docker is not available on the target.",
						},
					],
					details: { error: "docker-unavailable" },
				};
			}

			const parts = [
				"docker ps",
				'--format "ID: {{.ID}}  Name: {{.Names}}  Status: {{.Status}}  Ports: {{.Ports}}  Image: {{.Image}}"',
			];
			if (params.all) parts.push("-a");
			if (params.filter) parts.push("--filter", `name=${params.filter}`);

			try {
				const { stdout } = await execCommand(parts.join(" "), ctx.cwd, { signal });
				return {
					content: [{ type: "text", text: stdout || "(no containers found)" }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to list containers: ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- docker_services (compose) -------------------------------------------
	pi.registerTool({
		name: "docker_services",
		label: "Docker Compose Logs",
		description:
			"Fetch aggregated logs from a Docker Compose project. Useful when the app runs as multiple containers.",
		parameters: Type.Object({
			project: Type.Optional(
				Type.String({
					description:
						"Compose project name (-p). Defaults to current directory name.",
				}),
			),
			lines: Type.Optional(
				Type.Number({
					description: "Number of lines per service (default 50)",
					default: 50,
				}),
			),
			services: Type.Optional(
				Type.String({
					description: "Specific services, space-separated. Defaults to all.",
				}),
			),
			timestamps: Type.Optional(
				Type.Boolean({ description: "Include timestamps", default: false }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!dockerAvailable) {
				return {
					content: [
						{ type: "text", text: "Docker is not available on the target." },
					],
					details: { error: "docker-unavailable" },
				};
			}

			const parts = ["docker compose"];
			if (params.project) parts.push("-p", params.project);
			parts.push("logs", "--tail", String(params.lines ?? 50), "--no-color");
			if (params.timestamps) parts.push("-t");
			if (params.services) parts.push(...params.services.split(/\s+/));

			try {
				const { text } = safeOutput(
					(await execCommand(parts.join(" "), ctx.cwd, { signal })).stdout,
				);
				return {
					content: [{ type: "text", text: text || "(no compose logs)" }],
					details: { truncated: text.length >= MAX_OUTPUT_CHARS },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch compose logs: ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- server_journal (systemd) -------------------------------------------
	pi.registerTool({
		name: "server_journal",
		label: "Server Journal",
		description:
			"Fetch systemd journal logs for a service unit. Falls back to journalctl when Docker is not used.",
		parameters: Type.Object({
			unit: Type.String({
				description: "Systemd unit name, e.g. nginx, my-app.service",
			}),
			lines: Type.Optional(
				Type.Number({
					description: "Number of log entries (default 100)",
					default: 100,
				}),
			),
			since: Type.Optional(
				Type.String({
					description:
						'Only return entries since, e.g. "1 hour ago", "2024-01-01 00:00:00"',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const parts = [
				"journalctl",
				"-u",
				params.unit,
				"-n",
				String(params.lines ?? 100),
				"--no-pager",
			];
			if (params.since) parts.push("--since", params.since);

			try {
				const { text } = safeOutput(
					(await execCommand(parts.join(" "), ctx.cwd, { signal })).stdout,
				);
				return {
					content: [{ type: "text", text: text || "(no journal entries)" }],
					details: { unit: params.unit, truncated: text.length >= MAX_OUTPUT_CHARS },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch journal for "${params.unit}": ${(err as Error).message}`,
						},
					],
					details: { error: (err as Error).message },
				};
			}
		},
	});

	// ---- Lifecycle -----------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			if (arg.includes(":")) {
				const [remote, path] = arg.split(":");
				sshConfig = { remote: remote!, remoteCwd: path! };
			} else {
				const remote = arg;
				try {
					const pwd = (await sshExec(remote, "pwd")).toString().trim();
					sshConfig = { remote, remoteCwd: pwd };
				} catch {
					sshConfig = { remote, remoteCwd: "/" };
				}
			}
		} else {
			sshConfig = null;
		}

		dockerAvailable = await detectDocker();

		const target = sshConfig
			? `${sshConfig.remote}:${sshConfig.remoteCwd}`
			: "local";
		const status = dockerAvailable
			? ctx.ui.theme.fg("accent", `Docker: ${target}`)
			: ctx.ui.theme.fg("warning", `Docker: unavailable (${target})`);
		ctx.ui.setStatus("server-logs", status);
		ctx.ui.notify(
			dockerAvailable
				? `Server logs ready (${target})`
				: `Docker not found on ${target}. Docker tools disabled.`,
			dockerAvailable ? "info" : "warning",
		);
	});

	pi.on("session_shutdown", async () => {
		ctx.ui?.setStatus("server-logs", undefined);
	});
}
