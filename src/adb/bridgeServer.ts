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

export const ADB_BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_ADB_TCP_PORT = 5038;

type AdbHandshake = {
	type: "adb-handshake";
	version: number;
	adbHost: string;
	adbPort: number;
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

const TRAFFIC_LOG_INTERVAL_MS = 5_000;

class TrafficStats {
	private lastLog = Date.now();
	private toLocalBytes = 0;
	private toRemoteBytes = 0;

	constructor(private readonly label: string, private readonly logger: FastbootBridgeLogger) {}

	addToLocal(bytes: number): void {
		this.toLocalBytes += bytes;
		this.logIfNeeded();
	}

	addToRemote(bytes: number): void {
		this.toRemoteBytes += bytes;
		this.logIfNeeded();
	}

	private logIfNeeded(): void {
		const now = Date.now();
		const elapsed = now - this.lastLog;
		if (elapsed < TRAFFIC_LOG_INTERVAL_MS) {return;}
		const seconds = elapsed / 1000;
		this.logger.info(`${this.label} throughput: remote-adb-client->tcp ${(this.toRemoteBytes / seconds / 1024 / 1024).toFixed(2)} MiB/s, tcp->remote-adb-client ${(this.toLocalBytes / seconds / 1024 / 1024).toFixed(2)} MiB/s over ${seconds.toFixed(1)}s`);
		this.lastLog = now;
		this.toLocalBytes = 0;
		this.toRemoteBytes = 0;
	}
}

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
			if (!address || typeof address === "string") {reject(new Error("Cannot determine ADB TCP endpoint")); return;}
			resolve(address.port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(preferredPort, "127.0.0.1");
	});
}

type RemoteAdbClient = {
	socket: net.Socket;
	connectionId: number;
	outboundChain: Promise<void>;
	inboundChain: Promise<void>;
};

class AdbSession {
	private readonly tcpServer = net.createServer((socket) => this.acceptTcpClient(socket));
	private readonly tcpClients = new Map<number, RemoteAdbClient>();
	private nextConnectionId = 1;
	private nextFrameId = 1;
	private readonly pendingAcks = new Map<number, PendingAck>();
	private readonly trafficStats: TrafficStats;
	private stopPromise?: Promise<void>;
	private tcpPort?: number;

	constructor(
		private readonly ws: WebSocket,
		readonly handshake: AdbHandshake,
		private readonly logger: FastbootBridgeLogger,
	) {
		this.trafficStats = new TrafficStats("Local ADB bridge server", logger);
	}

	async start(preferredPort?: number): Promise<number> {
		this.tcpPort = await listen(this.tcpServer, preferredPort);
		if (preferredPort && this.tcpPort !== preferredPort) {
			this.logger.warn(`Local ADB bridge could not use TCP port ${preferredPort}; using 127.0.0.1:${this.tcpPort}`);
		}
		this.ws.on("message", (raw: WebSocket.Data) => void this.handleMessage(raw));
		this.ws.once("error", () => void this.stop());
		this.ws.send(JSON.stringify({
			type: "adb-handshake",
			version: ADB_BRIDGE_PROTOCOL_VERSION,
			tcpHost: "127.0.0.1",
			tcpPort: this.tcpPort,
			tcpEndpoint: `127.0.0.1:${this.tcpPort}`,
		}));
		this.logger.info(`Local ADB server ${this.handshake.adbHost}:${this.handshake.adbPort} available on remote at 127.0.0.1:${this.tcpPort}`);
		return this.tcpPort;
	}

	private acceptTcpClient(socket: net.Socket) {
		const connectionId = this.nextConnectionId++ >>> 0;
		const client: RemoteAdbClient = { socket, connectionId, outboundChain: Promise.resolve(), inboundChain: Promise.resolve() };
		this.tcpClients.set(connectionId, client);
		socket.setNoDelay(true);
		if (this.ws.readyState === WebSocket.OPEN) {this.ws.send(JSON.stringify({ type: "adb-open", connectionId }));}
		socket.on("data", (data) => {
			this.trafficStats.addToLocal(data.length);
			const operation = client.outboundChain.then(() => this.sendToLocalAdb(connectionId, Buffer.from(data)));
			client.outboundChain = operation.catch((error) => {
				if (!this.stopPromise) {this.logger.error(`Local ADB bridge write failed: ${(error as Error).message}`);}
			});
		});
		const clear = () => {
			if (this.tcpClients.get(connectionId) === client) {
				this.tcpClients.delete(connectionId);
				if (this.ws.readyState === WebSocket.OPEN) {this.ws.send(JSON.stringify({ type: "adb-close", connectionId }));}
			}
		};
		socket.once("close", clear);
		socket.once("error", clear);
	}

	private sendToLocalAdb(connectionId: number, data: Buffer): Promise<void> {
		if (this.ws.readyState !== WebSocket.OPEN) {return Promise.reject(new Error("Local ADB bridge is closed"));}
		const id = this.nextFrameId++ >>> 0;
		return new Promise<void>((resolve, reject) => {
			this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, id, this.withConnectionId(connectionId, data)), (error) => {
				if (error) {reject(error);}
				else {resolve();}
			});
		});
	}

	private async handleMessage(raw: WebSocket.Data) {
		try {
			if (!isWebSocketBinary(raw)) {
				this.handleControlMessage(raw.toString());
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

			const decoded = this.readConnectionPayload(frame.payload);
			const client = this.tcpClients.get(decoded.connectionId);
			if (!client) {
				if (this.ws.readyState === WebSocket.OPEN) {this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));}
				return;
			}
			client.inboundChain = client.inboundChain.then(async () => {
				this.trafficStats.addToRemote(decoded.payload.length);
				if (!client.socket.destroyed) {
					await new Promise<void>((resolve, reject) => client.socket.write(decoded.payload, (error) => error ? reject(error) : resolve()));
				}
				if (this.ws.readyState === WebSocket.OPEN) {this.ws.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));}
			});
			await client.inboundChain;
		} catch (error) {
			this.logger.error(`Local ADB bridge frame failed: ${(error as Error).message}`);
			this.ws.close(1011, "ADB bridge protocol error");
		}
	}

	private handleControlMessage(message: string) {
		try {
			const value = JSON.parse(message) as { type?: string; connectionId?: number };
			if (value.type === "adb-close" && Number.isInteger(value.connectionId)) {
				const client = this.tcpClients.get(value.connectionId!);
				if (client && !client.socket.destroyed) {
					client.inboundChain = client.inboundChain.then(() => new Promise<void>((resolve) => client.socket.end(resolve)));
				}
			}
		} catch {
			// Ignore unknown control messages.
		}
	}

	private withConnectionId(connectionId: number, payload: Buffer): Buffer {
		const result = Buffer.allocUnsafe(4 + payload.length);
		result.writeUInt32BE(connectionId >>> 0, 0);
		payload.copy(result, 4);
		return result;
	}

	private readConnectionPayload(payload: Buffer): { connectionId: number; payload: Buffer } {
		if (payload.length < 4) {throw new Error("Incomplete ADB bridge connection frame");}
		return { connectionId: payload.readUInt32BE(0), payload: payload.subarray(4) };
	}

	stop(): Promise<void> {
		if (!this.stopPromise) {this.stopPromise = this.stopInternal();}
		return this.stopPromise;
	}

	private async stopInternal(): Promise<void> {
		for (const pending of this.pendingAcks.values()) {pending.reject(new Error("Local ADB bridge stopped"));}
		this.pendingAcks.clear();
		for (const client of this.tcpClients.values()) {client.socket.destroy();}
		this.tcpClients.clear();
		await new Promise<void>((resolve) => this.tcpServer.close(() => resolve()));
		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {this.ws.close();}
	}
}

export class AdbBridgeServer {
	private server?: http.Server;
	private wss?: WebSocket.Server;
	private address?: net.AddressInfo;
	private session?: AdbSession;
	private retainedPort?: number;

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
			if (url.pathname !== "/adb") {
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
		this.logger.info(`Local ADB bridge listening on ${this.url()}`);
		return this.url();
	}

	private url(): string {
		return `http://127.0.0.1:${this.address!.port}/adb`;
	}

	private handleConnection(ws: WebSocket) {
		const timeout = setTimeout(() => ws.close(1008, "ADB handshake timed out"), 5_000);
		ws.once("message", async (raw: WebSocket.Data) => {
			clearTimeout(timeout);
			try {
				if (isWebSocketBinary(raw)) {throw new Error("Expected a JSON ADB handshake");}
				const handshake = JSON.parse(raw.toString()) as AdbHandshake;
				if (handshake.type !== "adb-handshake" || handshake.version !== ADB_BRIDGE_PROTOCOL_VERSION || !handshake.adbHost || !Number.isInteger(handshake.adbPort) || handshake.adbPort <= 0 || handshake.adbPort > 65535) {
					throw new Error("Unsupported ADB bridge handshake");
				}
				if (this.session) {await this.session.stop();}
				const session = new AdbSession(ws, handshake, this.logger);
				this.session = session;
				ws.once("close", () => {
					void session.stop().finally(() => {
						if (this.session === session) {this.session = undefined;}
					});
				});
				const tcpPort = await session.start(this.retainedPort ?? DEFAULT_ADB_TCP_PORT);
				this.retainedPort = tcpPort;
			} catch (error) {
				this.logger.error(`ADB handshake failed: ${(error as Error).message}`);
				ws.close(1008, "ADB handshake failed");
			}
		});
	}

	isListening(): boolean {
		return !!this.server?.listening;
	}

	async stop(): Promise<void> {
		await this.session?.stop();
		this.session = undefined;
		this.retainedPort = undefined;
		await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
		await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
		this.server = undefined;
		this.wss = undefined;
		this.address = undefined;
	}
}
