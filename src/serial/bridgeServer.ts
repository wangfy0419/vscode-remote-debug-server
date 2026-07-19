import * as http from "http";
import * as net from "net";
import WebSocket from "ws";
import {
	BRIDGE_FRAME_ACK,
	BRIDGE_FRAME_DATA,
	decodeBridgeFrame,
	encodeBridgeFrame,
	isWebSocketBinary,
} from "../bridge/frameProtocol";
import type { FastbootBridgeLogger } from "../fastboot/bridgeServer";

export const SERIAL_BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_SERIAL_TCP_PORT = 39001;

type SerialHandshake = {
	type: "serial-handshake";
	version: number;
	deviceId: string;
	name: string;
	path: string;
	baudRate: number;
};

type SerialState = {
	type: "serial-state";
	attached: boolean;
	path?: string;
};

type PendingAck = {
	resolve: () => void;
	reject: (error: Error) => void;
};

const NOOP_LOGGER: FastbootBridgeLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function listen(server: net.Server, preferredPort = 0): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			if (preferredPort && error.code === "EADDRINUSE") {
				server.off("error", onError);
				listen(server, 0).then(resolve, reject);
			} else {
				reject(error);
			}
		};
		const onListening = () => {
			server.off("error", onError);
			const address = server.address();
			if (!address || typeof address === "string") {reject(new Error("Cannot determine Serial TCP endpoint")); return;}
			resolve(address.port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(preferredPort, "127.0.0.1");
	});
}

class SerialSession {
	private readonly tcpServer = net.createServer((socket) => this.acceptTcpClient(socket));
	private tcpClient?: net.Socket;
	private attached = false;
	private nextFrameId = 1;
	private outboundChain: Promise<void> = Promise.resolve();
	private inboundChain: Promise<void> = Promise.resolve();
	private readonly pendingAcks = new Map<number, PendingAck>();
	private stopPromise?: Promise<void>;
	private tcpPort?: number;

	constructor(
		private readonly ws: WebSocket,
		readonly handshake: SerialHandshake,
		private readonly logger: FastbootBridgeLogger,
	) {}

	async start(preferredPort?: number): Promise<number> {
		this.tcpPort = await listen(this.tcpServer, preferredPort);
		if (preferredPort && this.tcpPort !== preferredPort) {
			this.logger.warn(`${this.handshake.name} could not use Serial TCP port ${preferredPort}; using 127.0.0.1:${this.tcpPort}`);
		}
		this.ws.on("message", (raw: WebSocket.Data) => void this.handleMessage(raw));
		this.ws.once("error", () => void this.stop());
		this.ws.send(JSON.stringify({
			type: "serial-handshake",
			version: SERIAL_BRIDGE_PROTOCOL_VERSION,
			tcpHost: "127.0.0.1",
			tcpPort: this.tcpPort,
			tcpEndpoint: `127.0.0.1:${this.tcpPort}`,
		}));
		this.logger.info(`${this.handshake.name} (${this.handshake.path}, ${this.handshake.baudRate}) available at 127.0.0.1:${this.tcpPort}`);
		return this.tcpPort;
	}

	private acceptTcpClient(socket: net.Socket) {
		if (this.tcpClient && !this.tcpClient.destroyed) {
			this.logger.warn(`${this.handshake.path} rejected a second Serial TCP client`);
			socket.destroy();
			return;
		}
		this.tcpClient = socket;
		socket.setNoDelay(true);
		if (!this.attached) {socket.pause();}
		socket.on("data", (data) => {
			const operation = this.outboundChain.then(() => this.sendToLocalSerial(Buffer.from(data)));
			this.outboundChain = operation.catch((error) => {
				if (!this.stopPromise) {this.logger.error(this.handshake.path, `Serial TCP write failed: ${(error as Error).message}`);}
			});
		});
		const clear = () => {
			if (this.tcpClient === socket) {this.tcpClient = undefined;}
		};
		socket.once("close", clear);
		socket.once("error", clear);
	}

	private sendToLocalSerial(data: Buffer): Promise<void> {
		if (this.ws.readyState !== WebSocket.OPEN) {return Promise.reject(new Error("Serial bridge is closed"));}
		const id = this.nextFrameId++ >>> 0;
		return new Promise<void>((resolve, reject) => {
			this.pendingAcks.set(id, { resolve, reject });
			this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, id, data), (error) => {
				if (error) {
					this.pendingAcks.delete(id);
					reject(error);
				}
			});
		});
	}

	private async handleMessage(raw: WebSocket.Data) {
		try {
			if (!isWebSocketBinary(raw)) {
				const state = JSON.parse(raw.toString()) as SerialState;
				if (state.type !== "serial-state") {throw new Error("Unknown Serial control message");}
				this.attached = state.attached;
				if (state.attached) {this.tcpClient?.resume();}
				else {this.tcpClient?.pause();}
				this.logger.info(`${this.handshake.name} is ${state.attached ? `attached at ${state.path || this.handshake.path}` : "waiting for local serial reattach"}`);
				return;
			}

			const frame = decodeBridgeFrame(raw as Buffer | ArrayBuffer | Buffer[]);
			if (frame.type === BRIDGE_FRAME_ACK) {
				const pending = this.pendingAcks.get(frame.id);
				if (pending) {
					this.pendingAcks.delete(frame.id);
					pending.resolve();
				}
				return;
			}

			this.inboundChain = this.inboundChain.then(async () => {
				const socket = this.tcpClient;
				if (socket && !socket.destroyed) {
					await new Promise<void>((resolve, reject) => socket.write(frame.payload, (error) => error ? reject(error) : resolve()));
				} else {
					this.logger.debug(this.handshake.path, `Dropping ${frame.payload.length} serial bytes because no TCP client is connected`);
				}
				if (this.ws.readyState === WebSocket.OPEN) {this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));}
			});
			await this.inboundChain;
		} catch (error) {
			this.logger.error(this.handshake.path, `Serial bridge frame failed: ${(error as Error).message}`);
			this.ws.close(1011, "Serial bridge protocol error");
		}
	}

	stop(): Promise<void> {
		if (!this.stopPromise) {this.stopPromise = this.stopInternal();}
		return this.stopPromise;
	}

	private async stopInternal(): Promise<void> {
		for (const pending of this.pendingAcks.values()) {pending.reject(new Error("Serial bridge stopped"));}
		this.pendingAcks.clear();
		this.tcpClient?.destroy();
		await new Promise<void>((resolve) => this.tcpServer.close(() => resolve()));
		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {this.ws.close();}
	}
}

export class SerialBridgeServer {
	private server?: http.Server;
	private wss?: WebSocket.Server;
	private address?: net.AddressInfo;
	private readonly sessions = new Set<SerialSession>();
	private readonly sessionsByDeviceId = new Map<string, SerialSession>();
	private readonly portsByDeviceId = new Map<string, number>();

	constructor(private readonly logger: FastbootBridgeLogger = NOOP_LOGGER) {}

	async start(port = 0): Promise<string> {
		if (this.server?.listening && this.address) {return this.url();}
		this.server = http.createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		this.wss = new WebSocket.Server({ noServer: true });
		this.server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			if (url.pathname !== "/serial") {
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
		this.logger.info(`Serial bridge listening on ${this.url()}`);
		return this.url();
	}

	private url(): string {
		return `http://127.0.0.1:${this.address!.port}/serial`;
	}

	private handleConnection(ws: WebSocket) {
		const timeout = setTimeout(() => ws.close(1008, "Serial handshake timed out"), 5_000);
		ws.once("message", async (raw: WebSocket.Data) => {
			clearTimeout(timeout);
			try {
				if (isWebSocketBinary(raw)) {throw new Error("Expected a JSON Serial handshake");}
				const handshake = JSON.parse(raw.toString()) as SerialHandshake;
				if (handshake.type !== "serial-handshake" || handshake.version !== SERIAL_BRIDGE_PROTOCOL_VERSION || !handshake.deviceId || !handshake.path || !Number.isInteger(handshake.baudRate) || handshake.baudRate <= 0) {
					throw new Error("Unsupported Serial bridge handshake");
				}
				const previous = this.sessionsByDeviceId.get(handshake.deviceId);
				if (previous) {
					await previous.stop();
					this.sessions.delete(previous);
					this.sessionsByDeviceId.delete(handshake.deviceId);
				}
				const session = new SerialSession(ws, handshake, this.logger);
				this.sessions.add(session);
				this.sessionsByDeviceId.set(handshake.deviceId, session);
				ws.once("close", () => {
					void session.stop().finally(() => {
						this.sessions.delete(session);
						if (this.sessionsByDeviceId.get(handshake.deviceId) === session) {this.sessionsByDeviceId.delete(handshake.deviceId);}
					});
				});
				const tcpPort = await session.start(this.portsByDeviceId.get(handshake.deviceId) ?? DEFAULT_SERIAL_TCP_PORT);
				this.portsByDeviceId.set(handshake.deviceId, tcpPort);
			} catch (error) {
				this.logger.error(`Serial handshake failed: ${(error as Error).message}`);
				ws.close(1008, "Serial handshake failed");
			}
		});
	}

	isListening(): boolean {
		return !!this.server?.listening;
	}

	async stop(): Promise<void> {
		await Promise.allSettled([...this.sessions].map((session) => session.stop()));
		this.sessions.clear();
		this.sessionsByDeviceId.clear();
		this.portsByDeviceId.clear();
		await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
		await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
		this.server = undefined;
		this.wss = undefined;
		this.address = undefined;
	}
}
