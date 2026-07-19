import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { applyEdits, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser/lib/esm/main';
import { Server } from 'remote-adb/server';
import { setLogger as setRemoteAdbLogger } from 'remote-adb/logger';

import { logger } from './logger';
import { FastbootBridgeServer } from './fastboot/bridgeServer';
import { SerialBridgeServer } from './serial/bridgeServer';
import { ContainerShellServer } from './containerShell/server';
import { AdbBridgeServer } from './adb/bridgeServer';

let server: Server|undefined = undefined;
let serverUri: vscode.Uri|undefined = undefined;
let fastbootServer: FastbootBridgeServer|undefined = undefined;
let fastbootServerUri: vscode.Uri|undefined = undefined;
let serialServer: SerialBridgeServer|undefined = undefined;
let serialServerUri: vscode.Uri|undefined = undefined;
let containerShellServer: ContainerShellServer|undefined = undefined;
let containerShellServerUri: vscode.Uri|undefined = undefined;
let adbBridgeServer: AdbBridgeServer|undefined = undefined;
let adbBridgeServerUri: vscode.Uri|undefined = undefined;
let remoteSerialInstallPromise: Promise<string>|undefined = undefined;
let adbExecutablePromise: Promise<string>|undefined = undefined;

type AdbDeviceInfo = { serial: string; name?: string };

async function remoteSerialScriptPath(context: vscode.ExtensionContext): Promise<string> {
	if (!remoteSerialInstallPromise) {
		remoteSerialInstallPromise = installRemoteSerialScript(context);
	}
	return remoteSerialInstallPromise;
}

async function installRemoteSerialScript(context: vscode.ExtensionContext): Promise<string> {
	const source = vscode.Uri.joinPath(context.extensionUri, "tools", "remote-serial", "remote-serial");
	const targetDirectory = vscode.Uri.file(`${os.homedir()}/tools`);
	const target = vscode.Uri.joinPath(targetDirectory, "remote-serial");
	await vscode.workspace.fs.createDirectory(targetDirectory);
	await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(source));
	try {
		await vscode.workspace.fs.stat(target);
		await new Promise<void>((resolve, reject) => {
			require("fs").chmod(target.fsPath, 0o755, (error: Error | null) => error ? reject(error) : resolve());
		});
	} catch (error) {
		logger.warn(`Failed to chmod remote-serial tool: ${(error as Error).message}`);
	}
	return target.fsPath;
}

function quotePosixShellArgument(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function serialLogFilePath(endpoint: string, label?: string, portIdentifier?: string): string {
	const rawKey = (portIdentifier || label || endpoint).trim();
	const normalizedKey = /^COM\d+$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey;
	const safeName = normalizedKey.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "serial";
	return path.join(os.homedir(), "serial-logs", `${safeName}.log`);
}

function adbCommandPrefix(adbServerSocket?: string): string {
	return adbServerSocket ? `ADB_SERVER_SOCKET=${quotePosixShellArgument(adbServerSocket)} ` : "";
}
async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findAdbExecutable(): Promise<string> {
	const candidates: string[] = [];
	for (const folder of vscode.workspace.workspaceFolders || []) {
		candidates.push(
			path.join(folder.uri.fsPath, "out", "host", "linux-x86", "bin", "adb"),
			path.join(folder.uri.fsPath, "prebuilts", "fullsdk-linux", "platform-tools", "adb"),
			path.join(folder.uri.fsPath, "prebuilts", "sdk", "tools", "linux", "bin", "adb"),
			path.join(folder.uri.fsPath, "prebuilts", "misc", "linux-x86", "adb", "adb"),
		);
	}
	for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(directory, "adb"));
	}
	candidates.push("/usr/bin/adb", "/usr/local/bin/adb");

	for (const candidate of candidates) {
		if (await isExecutable(candidate)) {
			logger.info(`Using adb executable: ${candidate}`);
			return candidate;
		}
	}
	logger.warn("No adb executable found in workspace or PATH; falling back to adb");
	return "adb";
}

async function adbExecutable(): Promise<string> {
	if (!adbExecutablePromise) {adbExecutablePromise = findAdbExecutable();}
	return adbExecutablePromise;
}

async function adbEnvironment(adbServerSocket?: string): Promise<NodeJS.ProcessEnv> {
	const adbPath = await adbExecutable();
	const directory = path.dirname(adbPath);
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {env[key] = value;}
	}
	if (directory && directory !== ".") {
		env.PATH = `${directory}${path.delimiter}${env.PATH || ""}`;
	}
	if (adbServerSocket) {
		env.ADB_SERVER_SOCKET = adbServerSocket;
	}
	return env;
}

async function adbTerminalOptions(adbServerSocket?: string): Promise<Pick<vscode.TerminalOptions, "env">> {
	return { env: await adbEnvironment(adbServerSocket) };
}

async function execAdb(args: string[], adbServerSocket?: string): Promise<string> {
	const adbPath = await adbExecutable();
	const env = await adbEnvironment(adbServerSocket);
	return new Promise<string>((resolve, reject) => {
		execFile(adbPath, args, { env }, (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
			const output = `${stdout || ""}${stderr || ""}`.trim();
			if (error) {reject(new Error(output || error.message)); return;}
			resolve(output);
		});
	});
}

function parseAdbDevices(output: string): AdbDeviceInfo[] {
	return output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
		const parts = line.split(/\s+/);
		if (parts[1] !== "device") {return [];}
		const model = parts.find((part) => part.startsWith("model:"))?.slice("model:".length).replace(/_/g, " ");
		const product = parts.find((part) => part.startsWith("product:"))?.slice("product:".length).replace(/_/g, " ");
		return [{ serial: parts[0], name: model || product || parts[0] }];
	});
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {throw new Error("Open a remote workspace before adding the MCP server");}
	if (folders.length === 1) {return folders[0];}
	const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the workspace for .vscode/mcp.json" });
	if (!selected) {throw new Error("No workspace was selected");}
	return selected;
}

async function addSerialToCopilotMcp(context: vscode.ExtensionContext): Promise<vscode.Uri> {
	const folder = await selectWorkspaceFolder();
	const vscodeDirectory = vscode.Uri.joinPath(folder.uri, ".vscode");
	const configUri = vscode.Uri.joinPath(vscodeDirectory, "mcp.json");
	let source = "{}\n";

	try {
		const raw = await vscode.workspace.fs.readFile(configUri);
		source = Buffer.from(raw).toString("utf8");
	} catch (error) {
		if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {throw error;}
	}

	const parseErrors: ParseError[] = [];
	const config = parse(source, parseErrors, { allowTrailingComma: true }) as unknown;
	if (parseErrors.length) {
		const first = parseErrors[0];
		throw new Error(`${configUri.fsPath} contains invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`${configUri.fsPath} must contain a JSON object`);
	}
	const existingServers = (config as Record<string, unknown>).servers;
	if (existingServers !== undefined && (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers))) {
		throw new Error(`${configUri.fsPath} has an invalid servers value`);
	}
	const serverDefinition = {
		type: "stdio",
		command: "python3",
		args: [await remoteSerialScriptPath(context), "--mcp"],
	};
	const updated = applyEdits(source, modify(source, ["servers", "remote-serial"], serverDefinition, {
		formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
	}));

	await vscode.workspace.fs.createDirectory(vscodeDirectory);
	await vscode.workspace.fs.writeFile(configUri, Buffer.from(updated.endsWith("\n") ? updated : `${updated}\n`, "utf8"));
	return configUri;
}

async function startServerAtPort(context: vscode.ExtensionContext, port: number): Promise<vscode.Uri> {
	server = new Server(
		{
			port: port,
			host: "127.0.0.1"
		},
		/* httpsOptions */ undefined,
		{
			staticClientPath: vscode.Uri.joinPath(context.extensionUri, "dist/web").fsPath,
		}
	);

	serverUri = vscode.Uri.parse(await server.start());
	return serverUri;
}

async function ensureServerListening(context: vscode.ExtensionContext) {
	if (!(server && server.isListening())) {
		let port: number = 44615;
		let remainingAttempts = 5;

		while (remainingAttempts > 0) {
			remainingAttempts--;

			try {
				await startServerAtPort(context, port);
				break;
			} catch (e: any) {
				if (e.code === "EADDRINUSE" && remainingAttempts > 0) {
					logger.info(`Port ${port} is already in use, trying another port...`);
					if (remainingAttempts === 1) {
						// Try random port on the last attempt
						port = 0;
					} else {
						port++;
					}
				} else {
					logger.error(`Failed to start server: ${e.message}`);
					throw e;
				}
			}
		}
	}
}

async function ensureFastbootServerListening() {
	if (fastbootServer?.isListening()) {return;}
	const configuration = vscode.workspace.getConfiguration("remote-debug-server");
	fastbootServer = new FastbootBridgeServer({
		fastbootPath: configuration.get<string>("fastbootPath", "fastboot"),
		autoRegister: configuration.get<boolean>("fastbootAutoRegister", true),
	}, logger);
	// Never choose a fixed bridge port. A local Code Helper/SSH endpoint can
	// coincidentally use the same number, causing asExternalUri() to reuse a
	// tunnel to VS Code Server and return HTTP 401 on WebSocket upgrade.
	fastbootServerUri = vscode.Uri.parse(await fastbootServer.start(0));
}

async function ensureSerialServerListening() {
	if (serialServer?.isListening()) {return;}
	serialServer = new SerialBridgeServer(logger);
	serialServerUri = vscode.Uri.parse(await serialServer.start(0));
}

async function ensureAdbBridgeServerListening() {
	if (adbBridgeServer?.isListening()) {return;}
	adbBridgeServer = new AdbBridgeServer(logger);
	adbBridgeServerUri = vscode.Uri.parse(await adbBridgeServer.start(0));
}

async function ensureContainerShellServerListening() {
	if (containerShellServer?.isListening()) {return;}
	const configuration = vscode.workspace.getConfiguration("remote-debug-server");
	const configuredCwd = configuration.get<string>("containerShellCwd", "").trim();
	const cwd = configuredCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
	containerShellServer = new ContainerShellServer({
		shellPath: configuration.get<string>("containerShellPath", "/bin/bash"),
		cwd,
	}, logger);
	containerShellServerUri = vscode.Uri.parse(await containerShellServer.start(0));
}

export function activate(context: vscode.ExtensionContext) {
	setRemoteAdbLogger(logger);

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.activate', async () => {
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.openExternal', async () => {
		await ensureServerListening(context);

		if (serverUri) {
			await vscode.env.openExternal(serverUri);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.getExternalUrl', async (): Promise<vscode.Uri|undefined> => {
		await ensureServerListening(context);

		if (serverUri) {
			return await vscode.env.asExternalUri(serverUri);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.getFastbootExternalUrl', async (): Promise<vscode.Uri|undefined> => {
		await ensureFastbootServerListening();
		return fastbootServerUri;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.getSerialExternalUrl', async (): Promise<vscode.Uri|undefined> => {
		await ensureSerialServerListening();
		return serialServerUri;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.getAdbBridgeExternalUrl', async (): Promise<vscode.Uri|undefined> => {
		await ensureAdbBridgeServerListening();
		return adbBridgeServerUri;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.openSerialTerminal', async (endpoint: string, label?: string) => {
		if (typeof endpoint !== "string" || !endpoint.trim()) {
			throw new Error("A Serial TCP endpoint is required");
		}
		const terminal = vscode.window.createTerminal({
			name: `Serial: ${label || endpoint}`,
			shellPath: await remoteSerialScriptPath(context),
			shellArgs: [endpoint],
			location: vscode.TerminalLocation.Editor,
		});
		terminal.show();
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.openSerialLogTerminal', async (endpoint: string, label?: string, portIdentifier?: string) => {
		if (typeof endpoint !== "string" || !endpoint.trim()) {
			throw new Error("A Serial TCP endpoint is required");
		}
		const logFile = serialLogFilePath(endpoint, label, portIdentifier);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(logFile)));
		const terminal = vscode.window.createTerminal({
			name: `Serial Log: ${label || endpoint}`,
			shellPath: await remoteSerialScriptPath(context),
			shellArgs: ["--timestamps", "--log-file", logFile, endpoint],
			location: vscode.TerminalLocation.Editor,
		});
		terminal.show();
		vscode.window.showInformationMessage(`Serial log file: ${logFile}`);
		return logFile;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.listAdbBridgeDevices', async (endpoint: string): Promise<AdbDeviceInfo[]> => {
		if (typeof endpoint !== "string" || !endpoint.trim()) {
			return [];
		}
		return parseAdbDevices(await execAdb(["devices", "-l"], `tcp:${endpoint}`));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.openAdbDevicesTerminal', async (endpoint: string, label?: string) => {
		if (typeof endpoint !== "string" || !endpoint.trim()) {
			throw new Error("An ADB TCP endpoint is required");
		}
		const adbServerSocket = `tcp:${endpoint}`;
		const terminal = vscode.window.createTerminal({
			name: `ADB Devices: ${label || endpoint}`,
			location: vscode.TerminalLocation.Editor,
			...(await adbTerminalOptions(adbServerSocket)),
		});
		terminal.show();
		terminal.sendText(`${adbCommandPrefix(adbServerSocket)}adb devices -l`, true);
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.openDeviceShell', async (serial: string, label?: string, adbServerSocket?: string) => {
		if (typeof serial !== "string" || !serial.trim()) {
			throw new Error("An ADB device serial is required");
		}
		const terminal = vscode.window.createTerminal({
			name: `ADB Shell: ${label || serial}`,
			location: vscode.TerminalLocation.Editor,
			...(await adbTerminalOptions(adbServerSocket)),
		});
		terminal.show();
		terminal.sendText(`${adbCommandPrefix(adbServerSocket)}adb -s ${quotePosixShellArgument(serial)} shell`, true);
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.startLogcat', async (serial: string, label?: string, adbServerSocket?: string) => {
		if (typeof serial !== "string" || !serial.trim()) {
			throw new Error("An ADB device serial is required");
		}
		const terminal = vscode.window.createTerminal({
			name: `Logcat: ${label || serial}`,
			location: vscode.TerminalLocation.Editor,
			...(await adbTerminalOptions(adbServerSocket)),
		});
		terminal.show();
		terminal.sendText(`${adbCommandPrefix(adbServerSocket)}adb -s ${quotePosixShellArgument(serial)} logcat -v threadtime`, true);
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.captureScreenshot', async (serial: string, label?: string, adbServerSocket?: string) => {
		if (typeof serial !== "string" || !serial.trim()) {
			throw new Error("An ADB device serial is required");
		}
		const safeLabel = (label || serial).replace(/[^A-Za-z0-9._-]+/g, "_");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const fileName = `screenshot-${safeLabel}-${timestamp}.png`;
		const target = vscode.Uri.file(`${os.homedir()}/Pictures/${fileName}`);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(`${os.homedir()}/Pictures`));
		const terminal = vscode.window.createTerminal({
			name: `Screenshot: ${label || serial}`,
			location: vscode.TerminalLocation.Editor,
			...(await adbTerminalOptions(adbServerSocket)),
		});
		terminal.show();
		terminal.sendText(`${adbCommandPrefix(adbServerSocket)}adb -s ${quotePosixShellArgument(serial)} exec-out screencap -p > ${quotePosixShellArgument(target.fsPath)}`, true);
		vscode.window.showInformationMessage(`Screenshot command started: ${target.fsPath}`);
		return target.fsPath;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.addSerialToCopilotMcp', async () => {
		const configUri = await addSerialToCopilotMcp(context);
		const document = await vscode.workspace.openTextDocument(configUri);
		await vscode.window.showTextDocument(document, { preview: false });
		vscode.window.showInformationMessage("Remote Serial was added to the workspace GitHub Copilot MCP configuration.");
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.addSerialToClaudeMcp', async () => {
		const scriptPath = await remoteSerialScriptPath(context);
		const command = `claude mcp add --transport stdio --scope local remote-serial -- python3 ${quotePosixShellArgument(scriptPath)} --mcp`;
		const terminal = vscode.window.createTerminal({
			name: "Add Remote Serial to Claude Code MCP",
			location: vscode.TerminalLocation.Editor,
		});
		terminal.show();
		terminal.sendText(command, true);
		return true;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.getContainerShellExternalUrl', async (): Promise<vscode.Uri|undefined> => {
		await ensureContainerShellServerListening();
		return containerShellServerUri;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.stopFastbootServer', async () => {
		await fastbootServer?.stop();
		fastbootServer = undefined;
		fastbootServerUri = undefined;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.stopSerialServer', async () => {
		await serialServer?.stop();
		serialServer = undefined;
		serialServerUri = undefined;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.stopAdbBridgeServer', async () => {
		await adbBridgeServer?.stop();
		adbBridgeServer = undefined;
		adbBridgeServerUri = undefined;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.stopContainerShellServer', async () => {
		await containerShellServer?.stop();
		containerShellServer = undefined;
		containerShellServerUri = undefined;
	}));

	context.subscriptions.push(vscode.commands.registerCommand('remote-debug-server.stopServer', async () => {
		await server?.stop();
		await fastbootServer?.stop();
		await serialServer?.stop();
		await adbBridgeServer?.stop();
		await containerShellServer?.stop();
	}));
}

export async function deactivate() {
	await Promise.allSettled([server?.stop(), fastbootServer?.stop(), serialServer?.stop(), adbBridgeServer?.stop(), containerShellServer?.stop()]);
}
