import { execFile } from "child_process";
import * as http from "http";
import * as net from "net";
import WebSocket from "ws";
import {
	BRIDGE_FRAME_ACK,
	BRIDGE_FRAME_DATA,
	BRIDGE_PROTOCOL_VERSION,
	decodeBridgeFrame,
	encodeBridgeFrame,
	isWebSocketBinary,
} from "./frameProtocol";
import { EndpointOwner, FastbootEndpointSession, TcpFastbootEndpoint } from "./tcpEndpoint";
import { UdpFastbootEndpoint } from "./udpEndpoint";

export type FastbootBridgeConfiguration = {
	fastbootPath: string;
	autoRegister: boolean;
	commandRunner?: (path: string, args: string[]) => Promise<string>;
};

export type FastbootBridgeLogger = {
	debug(...data: unknown[]): void;
	info(...data: unknown[]): void;
	warn(...data: unknown[]): void;
	error(...data: unknown[]): void;
};

const NOOP_LOGGER: FastbootBridgeLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

type ClientHandshake = {
	type: "fastboot-handshake";
	version: number;
	name: string;
	serial: string;
};

type FastbootEndpointPorts = {
	tcpPort: number;
	udpPort: number;
};

type FastbootDisconnectRequest = {
	type: "fastboot-disconnect";
};

function runFastboot(path: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(path, args, { timeout: 10_000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || stdout || error.message).trim()));
			} else {
				resolve((stdout || stderr).trim());
			}
		});
	});
}

class FastbootSession implements FastbootEndpointSession {
	private owner?: EndpointOwner;
	private readonly tcp = new TcpFastbootEndpoint(this);
	private readonly udp = new UdpFastbootEndpoint(this);
	private tcpSerial?: string;
	private udpSerial?: string;
	private nextFrameId = 1;
	private outboundChain: Promise<void> = Promise.resolve();
	private readonly pendingAcks = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private stopPromise?: Promise<void>;
	private registrationDisconnected = false;
	private registrationDisconnectPromise?: Promise<void>;

	constructor(
		private readonly ws: WebSocket,
		private readonly handshake: ClientHandshake,
		private readonly config: FastbootBridgeConfiguration,
		private readonly logger: FastbootBridgeLogger,
	) {}

	async start(preferredPorts?: FastbootEndpointPorts): Promise<FastbootEndpointPorts> {
		let tcpPort: number;
		let udpPort: number;
		try {
			[tcpPort, udpPort] = await Promise.all([
				this.tcp.start(preferredPorts?.tcpPort),
				this.udp.start(preferredPorts?.udpPort),
			]);
		} catch (error) {
			await Promise.allSettled([this.tcp.stop(), this.udp.stop()]);
			throw error;
		}
		this.tcpSerial = `tcp:127.0.0.1:${tcpPort}`;
		this.udpSerial = `udp:127.0.0.1:${udpPort}`;

		this.ws.on("message", (data: WebSocket.Data) => {
			if (isWebSocketBinary(data)) {void this.handleBridgeFrame(data as any);}
			else {void this.handleControlMessage(data);}
		});
		this.ws.once("close", () => void this.stop());
		this.ws.once("error", () => void this.stop());

		let registrationWarning: string | undefined;
		if (this.config.autoRegister) {
			try {
				await this.runFastboot(["connect", this.tcpSerial]);
			} catch (error) {
				registrationWarning = (error as Error).message;
				this.logger.warn(this.handshake.serial, `Fastboot auto-registration failed: ${registrationWarning}`);
			}
		}

		this.ws.send(JSON.stringify({
			type: "fastboot-handshake",
			version: BRIDGE_PROTOCOL_VERSION,
			tcpSerial: this.tcpSerial,
			udpSerial: this.udpSerial,
			registrationWarning,
		}));
		this.logger.info(`${this.handshake.name} (${this.handshake.serial}) available as ${this.tcpSerial} and ${this.udpSerial}`);
		return { tcpPort, udpPort };
	}

	acquire(owner: EndpointOwner): boolean {
		if (this.owner && this.owner !== owner) {return false;}
		this.owner = owner;
		return true;
	}

	release(owner: EndpointOwner): void {
		if (this.owner === owner) {this.owner = undefined;}
	}

	sendToUsb(data: Buffer): Promise<void> {
		this.logger.debug(this.handshake.serial, `Fastboot ${this.owner || "unowned"} -> bridge (${this.describeFastbootData(data)})`);
		const operation = this.outboundChain.then(() => this.sendDataFrame(data));
		this.outboundChain = operation.catch(() => undefined);
		return operation;
	}

	private sendDataFrame(data: Buffer): Promise<void> {
		if (this.ws.readyState !== WebSocket.OPEN) {return Promise.reject(new Error("Fastboot bridge is closed"));}
		const id = this.nextFrameId++ >>> 0;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAcks.delete(id);
				reject(new Error("Timed out writing to local fastboot USB device"));
			}, 60_000);
			this.pendingAcks.set(id, { resolve, reject, timer });
			this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, id, data), (error) => {
				if (error) {
					clearTimeout(timer);
					this.pendingAcks.delete(id);
					reject(error);
				}
			});
		});
	}

	private async handleBridgeFrame(raw: Buffer | ArrayBuffer | Buffer[]) {
		try {
			const frame = decodeBridgeFrame(raw);
			if (frame.type === BRIDGE_FRAME_ACK) {
				const pending = this.pendingAcks.get(frame.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingAcks.delete(frame.id);
					pending.resolve();
				}
				return;
			}

			this.logger.debug(this.handshake.serial, `Fastboot bridge -> ${this.owner || "unowned"} (${this.describeFastbootData(frame.payload)})`);
			if (this.owner === "tcp") {await this.tcp.acceptUsbData(frame.payload);}
			else if (this.owner === "udp") {await this.udp.acceptUsbData(frame.payload);}
			else {this.logger.warn(this.handshake.serial, "Dropping Fastboot USB data because no TCP or UDP client owns the session");}
			this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));
		} catch (error) {
			this.logger.error(this.handshake.serial, `Fastboot bridge frame failed: ${(error as Error).message}`);
			this.ws.close(1011, "Fastboot bridge protocol error");
		}
	}

	private describeFastbootData(data: Buffer): string {
		if (data.length <= 128) {
			const text = data.toString("ascii");
			if (/^[\x20-\x7e]*$/.test(text)) {return `${data.length} bytes: ${text}`;}
		}
		return `${data.length} bytes`;
	}

	private runFastboot(args: string[]): Promise<string> {
		return (this.config.commandRunner ?? runFastboot)(this.config.fastbootPath, args);
	}

	private async handleControlMessage(raw: WebSocket.Data) {
		try {
			const request = JSON.parse(raw.toString()) as FastbootDisconnectRequest;
			if (request.type !== "fastboot-disconnect") {throw new Error("Unknown Fastboot control message");}
			await this.disconnectRegistration();
			if (this.ws.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: "fastboot-disconnect-result", success: true }));
			}
		} catch (error) {
			const message = (error as Error).message;
			this.logger.warn(this.handshake.serial, `Fastboot explicit disconnect failed: ${message}`);
			if (this.ws.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: "fastboot-disconnect-result", success: false, error: message }));
			}
		}
	}

	private async disconnectRegistration(): Promise<void> {
		if (!this.config.autoRegister || !this.tcpSerial || this.registrationDisconnected) {return;}
		if (this.registrationDisconnectPromise) {return this.registrationDisconnectPromise;}
		const serial = this.tcpSerial;
		const operation = this.runFastboot(["disconnect", serial]).then(() => {
			this.registrationDisconnected = true;
			this.logger.info(this.handshake.serial, `Fastboot registration disconnected: ${serial}`);
		});
		this.registrationDisconnectPromise = operation;
		try {
			await operation;
		} finally {
			if (this.registrationDisconnectPromise === operation) {this.registrationDisconnectPromise = undefined;}
		}
	}

	stop(): Promise<void> {
		if (!this.stopPromise) {this.stopPromise = this.stopInternal();}
		return this.stopPromise;
	}

	private async stopInternal(): Promise<void> {
		for (const pending of this.pendingAcks.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Fastboot bridge stopped"));
		}
		this.pendingAcks.clear();
		try {
			await this.disconnectRegistration();
		} catch (error) {
			this.logger.warn(this.handshake.serial, `Fastboot disconnect cleanup failed: ${(error as Error).message}`);
		}
		await Promise.allSettled([this.tcp.stop(), this.udp.stop()]);
		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {this.ws.close();}
	}
}

export class FastbootBridgeServer {
	private server?: http.Server;
	private wss?: WebSocket.Server;
	private address?: net.AddressInfo;
	private readonly sessions = new Set<FastbootSession>();
	private readonly sessionsBySerial = new Map<string, FastbootSession>();
	private readonly portsBySerial = new Map<string, FastbootEndpointPorts>();

	constructor(
		private readonly config: FastbootBridgeConfiguration,
		private readonly logger: FastbootBridgeLogger = NOOP_LOGGER,
	) {}

	async start(port = 44625): Promise<string> {
		if (this.server?.listening && this.address) {return this.url();}
		this.server = http.createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		this.wss = new WebSocket.Server({ noServer: true });
		this.server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			if (url.pathname !== "/fastboot") {
				this.logger.warn(`Rejected Fastboot WebSocket upgrade: path=${url.pathname}`);
				socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
				socket.destroy();
				return;
			}
			this.wss!.handleUpgrade(request, socket as net.Socket, head, (ws) => this.wss!.emit("connection", ws, request));
		});
		this.wss.on("connection", (ws) => this.handleConnection(ws));

		this.address = await new Promise<net.AddressInfo>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, "127.0.0.1", () => {
				this.server!.off("error", reject);
				resolve(this.server!.address() as net.AddressInfo);
			});
		});
		this.logger.info(`Fastboot bridge listening on ${this.url()}`);
		return this.url();
	}

	private url(): string {
		return `http://127.0.0.1:${this.address!.port}/fastboot`;
	}

	private handleConnection(ws: WebSocket) {
		const timeout = setTimeout(() => ws.close(1008, "Fastboot handshake timed out"), 5_000);
		ws.once("message", async (raw: WebSocket.Data) => {
			clearTimeout(timeout);
			try {
				if (isWebSocketBinary(raw)) {throw new Error("Expected a JSON handshake");}
				const handshake = JSON.parse(raw.toString()) as ClientHandshake;
				if (handshake.type !== "fastboot-handshake" || handshake.version !== BRIDGE_PROTOCOL_VERSION || !handshake.serial) {
					throw new Error("Unsupported fastboot bridge handshake");
				}
				const previousSession = this.sessionsBySerial.get(handshake.serial);
				if (previousSession) {
					this.logger.info(`${handshake.serial} replacing the previous Fastboot transport while retaining its endpoints`);
					await previousSession.stop();
					this.sessions.delete(previousSession);
					this.sessionsBySerial.delete(handshake.serial);
				}
				const session = new FastbootSession(ws, handshake, this.config, this.logger);
				this.sessions.add(session);
				this.sessionsBySerial.set(handshake.serial, session);
				ws.once("close", () => {
					void session.stop().finally(() => {
						this.sessions.delete(session);
						if (this.sessionsBySerial.get(handshake.serial) === session) {
							this.sessionsBySerial.delete(handshake.serial);
						}
					});
				});
				const ports = await session.start(this.portsBySerial.get(handshake.serial));
				this.portsBySerial.set(handshake.serial, ports);
			} catch (error) {
				this.logger.error(`Fastboot handshake failed: ${(error as Error).message}`);
				ws.close(1008, "Fastboot handshake failed");
			}
		});
	}

	isListening(): boolean {
		return !!this.server?.listening;
	}

	async stop(): Promise<void> {
		await Promise.allSettled([...this.sessions].map((session) => session.stop()));
		this.sessions.clear();
		this.sessionsBySerial.clear();
		this.portsBySerial.clear();
		await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
		await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
		this.server = undefined;
		this.wss = undefined;
		this.address = undefined;
	}
}
