import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import WebSocket from "ws";

export const CONTAINER_SHELL_PROTOCOL_VERSION = 1;
const FORCE_KILL_DELAY_MS = 2_000;

export type ContainerShellConfiguration = {
	shellPath: string;
	cwd: string;
};

export type ContainerShellLogger = {
	debug(...data: unknown[]): void;
	info(...data: unknown[]): void;
	warn(...data: unknown[]): void;
	error(...data: unknown[]): void;
};

type ExecRequest = { type: "exec"; id: string; command: string; timeoutMs?: number };
type CancelRequest = { type: "cancel"; id: string };

type RunningCommand = {
	child: ChildProcessWithoutNullStreams;
	startedAt: number;
	timeout?: NodeJS.Timeout;
	forceKill?: NodeJS.Timeout;
};

function sendJson(ws: WebSocket, value: unknown): void {
	if (ws.readyState === WebSocket.OPEN) {ws.send(JSON.stringify(value));}
}

function killProcessGroup(command: RunningCommand, signal: NodeJS.Signals): void {
	const pid = command.child.pid;
	if (!pid) {return;}
	try {
		process.kill(-pid, signal);
	} catch {
		try {command.child.kill(signal);} catch { /* The process already exited. */ }
	}
}

function terminate(command: RunningCommand): void {
	if (command.child.exitCode !== null || command.child.signalCode !== null) {return;}
	killProcessGroup(command, "SIGTERM");
	if (!command.forceKill) {
		command.forceKill = setTimeout(() => killProcessGroup(command, "SIGKILL"), FORCE_KILL_DELAY_MS);
	}
}

export function validateContainerShellConfiguration(configuration: ContainerShellConfiguration): void {
	if (!path.isAbsolute(configuration.shellPath) || !fs.existsSync(configuration.shellPath) || !fs.statSync(configuration.shellPath).isFile()) {
		throw new Error(`Container shell does not exist: ${configuration.shellPath}`);
	}
	try {fs.accessSync(configuration.shellPath, fs.constants.X_OK);} catch {throw new Error(`Container shell is not executable: ${configuration.shellPath}`);}
	if (!path.isAbsolute(configuration.cwd) || !fs.existsSync(configuration.cwd) || !fs.statSync(configuration.cwd).isDirectory()) {
		throw new Error(`Container shell working directory does not exist: ${configuration.cwd}`);
	}
}

export class ContainerShellServer {
	private server?: http.Server;
	private wss?: WebSocket.Server;
	private address?: net.AddressInfo;
	private readonly clients = new Set<WebSocket>();
	private readonly commands = new Map<WebSocket, Map<string, RunningCommand>>();

	constructor(
		private readonly configuration: ContainerShellConfiguration,
		private readonly logger: ContainerShellLogger,
	) {}

	async start(port = 0): Promise<string> {
		if (this.server?.listening && this.address) {return this.url();}
		validateContainerShellConfiguration(this.configuration);
		this.server = http.createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		this.wss = new WebSocket.Server({ noServer: true });
		this.server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			if (url.pathname !== "/container-shell") {
				socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
				socket.destroy();
				return;
			}
			this.wss!.handleUpgrade(request, socket as net.Socket, head, (ws) => this.wss!.emit("connection", ws, request));
		});
		this.wss.on("connection", (ws) => this.acceptClient(ws));

		this.address = await new Promise<net.AddressInfo>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, "127.0.0.1", () => {
				this.server!.off("error", reject);
				resolve(this.server!.address() as net.AddressInfo);
			});
		});
		this.logger.info(`Container Shell listening on ${this.url()}`);
		return this.url();
	}

	private url(): string {
		return `http://127.0.0.1:${this.address!.port}/container-shell`;
	}

	private acceptClient(ws: WebSocket): void {
		this.clients.add(ws);
		this.commands.set(ws, new Map());
		sendJson(ws, {
			type: "ready",
			version: CONTAINER_SHELL_PROTOCOL_VERSION,
			shellPath: this.configuration.shellPath,
			cwd: this.configuration.cwd,
		});
		ws.on("message", (raw: WebSocket.Data) => this.handleMessage(ws, raw));
		ws.once("close", () => this.closeClient(ws));
		ws.once("error", () => this.closeClient(ws));
	}

	private handleMessage(ws: WebSocket, raw: WebSocket.Data): void {
		if (typeof raw !== "string") {
			sendJson(ws, { type: "error", code: "INVALID_MESSAGE", message: "Container Shell accepts JSON text messages only" });
			return;
		}
		let request: ExecRequest | CancelRequest;
		try {
			request = JSON.parse(raw);
		} catch {
			sendJson(ws, { type: "error", code: "INVALID_JSON", message: "Invalid JSON message" });
			return;
		}
		if (!request || typeof request !== "object" || typeof request.id !== "string" || !request.id) {
			sendJson(ws, { type: "error", code: "INVALID_REQUEST", message: "A non-empty string id is required" });
			return;
		}
		if (request.type === "cancel") {
			const command = this.commands.get(ws)?.get(request.id);
			if (!command) {sendJson(ws, { type: "error", id: request.id, code: "NOT_RUNNING", message: "Command is not running" });}
			else {terminate(command);}
			return;
		}
		if (request.type !== "exec" || typeof request.command !== "string" || !request.command) {
			sendJson(ws, { type: "error", id: request.id, code: "INVALID_REQUEST", message: "exec requires a non-empty command" });
			return;
		}
		if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0)) {
			sendJson(ws, { type: "error", id: request.id, code: "INVALID_REQUEST", message: "timeoutMs must be a non-negative integer" });
			return;
		}
		const commands = this.commands.get(ws)!;
		if (commands.has(request.id)) {
			sendJson(ws, { type: "error", id: request.id, code: "DUPLICATE_ID", message: "A command with this id is already running" });
			return;
		}
		this.execute(ws, request, commands);
	}

	private execute(ws: WebSocket, request: ExecRequest, commands: Map<string, RunningCommand>): void {
		const child = spawn(this.configuration.shellPath, ["-lc", request.command], {
			cwd: this.configuration.cwd,
			env: process.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const running: RunningCommand = { child, startedAt: Date.now() };
		commands.set(request.id, running);
		child.stdout.on("data", (data: Buffer) => sendJson(ws, { type: "stdout", id: request.id, data: data.toString("base64") }));
		child.stderr.on("data", (data: Buffer) => sendJson(ws, { type: "stderr", id: request.id, data: data.toString("base64") }));
		child.once("spawn", () => {
			sendJson(ws, { type: "started", id: request.id, pid: child.pid });
			if (request.timeoutMs) {
				running.timeout = setTimeout(() => {
					sendJson(ws, { type: "error", id: request.id, code: "COMMAND_TIMEOUT", message: `Command timed out after ${request.timeoutMs} ms` });
					terminate(running);
				}, request.timeoutMs);
			}
		});
		child.once("error", (error) => {
			sendJson(ws, { type: "error", id: request.id, code: "SPAWN_FAILED", message: error.message });
			this.finish(commands, request.id, running);
		});
		child.once("exit", (exitCode, signal) => {
			sendJson(ws, { type: "exit", id: request.id, exitCode, signal, durationMs: Date.now() - running.startedAt });
			this.finish(commands, request.id, running);
		});
	}

	private finish(commands: Map<string, RunningCommand>, id: string, command: RunningCommand): void {
		if (command.timeout) {clearTimeout(command.timeout);}
		if (command.forceKill) {clearTimeout(command.forceKill);}
		if (commands.get(id) === command) {commands.delete(id);}
	}

	private closeClient(ws: WebSocket): void {
		if (!this.clients.delete(ws)) {return;}
		const commands = this.commands.get(ws);
		if (commands) {
			for (const command of commands.values()) {terminate(command);}
			this.commands.delete(ws);
		}
	}

	isListening(): boolean {
		return !!this.server?.listening;
	}

	async stop(): Promise<void> {
		for (const ws of this.clients) {
			this.closeClient(ws);
			ws.terminate();
		}
		this.clients.clear();
		await new Promise<void>((resolve) => {
			if (!this.server?.listening) {resolve(); return;}
			this.server.close(() => resolve());
		});
		this.wss?.close();
		this.server = undefined;
		this.wss = undefined;
		this.address = undefined;
	}
}
