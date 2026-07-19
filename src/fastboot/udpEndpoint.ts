import * as dgram from "dgram";
import { EndpointOwner, FastbootEndpointSession } from "./tcpEndpoint";

const ID_ERROR = 0;
const ID_QUERY = 1;
const ID_INIT = 2;
const ID_FASTBOOT = 3;
const FLAG_CONTINUATION = 1;
const PROTOCOL_VERSION = 1;
const MAX_PACKET_SIZE = 8192;
const HEADER_SIZE = 4;
const SESSION_IDLE_MS = 90_000;

type Client = {
	address: string;
	port: number;
	nextSequence: number;
	packetSize: number;
	pendingRead?: { sequence: number; address: string; port: number };
	lastResponse?: { sequence: number; packet: Buffer };
	lastActive: number;
};

type QueuedUsbData = { data: Buffer; offset: number; resolve: () => void };

export class UdpFastbootEndpoint {
	private readonly socket = dgram.createSocket("udp4");
	private client?: Client;
	private readonly usbQueue: QueuedUsbData[] = [];
	private readonly processingSequences = new Set<number>();
	private cleanupTimer?: NodeJS.Timeout;
	private listening = false;

	constructor(private readonly session: FastbootEndpointSession) {}

	async start(port = 0): Promise<number> {
		this.socket.on("message", (message, remote) => void this.handlePacket(message, remote));
		this.socket.on("error", () => undefined);
		const boundPort = await new Promise<number>((resolve, reject) => {
			this.socket.once("error", reject);
			this.socket.bind(port, "127.0.0.1", () => {
				this.socket.off("error", reject);
				resolve(this.socket.address().port);
			});
		});
		this.listening = true;
		this.cleanupTimer = setInterval(() => this.expireClient(), 5_000);
		return boundPort;
	}

	private header(id: number, flags: number, sequence: number, payload = Buffer.alloc(0)): Buffer {
		const result = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
		result[0] = id;
		result[1] = flags;
		result.writeUInt16BE(sequence & 0xffff, 2);
		payload.copy(result, HEADER_SIZE);
		return result;
	}

	private send(packet: Buffer, port: number, address: string): Promise<void> {
		return new Promise((resolve, reject) => this.socket.send(packet, port, address, (error) => error ? reject(error) : resolve()));
	}

	private respond(packet: Buffer, sequence: number, port: number, address: string): Promise<void> {
		if (this.client) {this.client.lastResponse = { sequence, packet: Buffer.from(packet) };}
		return this.send(packet, port, address);
	}

	private sameClient(remote: dgram.RemoteInfo): boolean {
		return !!this.client && this.client.address === remote.address && this.client.port === remote.port;
	}

	private resetClient(remote: dgram.RemoteInfo) {
		if (this.client) {this.session.release("udp");}
		this.processingSequences.clear();
		while (this.usbQueue.length) {this.usbQueue.shift()!.resolve();}
		this.client = {
			address: remote.address,
			port: remote.port,
			nextSequence: 0,
			packetSize: 512,
			lastActive: Date.now(),
		};
	}

	private async handlePacket(message: Buffer, remote: dgram.RemoteInfo) {
		if (message.length < HEADER_SIZE) {return;}
		const id = message[0];
		const flags = message[1];
		const sequence = message.readUInt16BE(2);
		const payload = message.subarray(HEADER_SIZE);

		try {
			if (id === ID_QUERY) {
				this.resetClient(remote);
				const next = Buffer.alloc(2);
				next.writeUInt16BE(this.client!.nextSequence);
				await this.respond(this.header(ID_QUERY, 0, sequence, next), sequence, remote.port, remote.address);
				return;
			}

			if (!this.sameClient(remote) || !this.client) {return;}
			this.client.lastActive = Date.now();

			if (sequence !== this.client.nextSequence) {
				if (this.client.lastResponse?.sequence === sequence) {
					await this.send(this.client.lastResponse.packet, remote.port, remote.address);
				}
				return;
			}
			if (this.processingSequences.has(sequence)) {return;}

			if (id === ID_INIT) {
				if (payload.length < 4 || payload.readUInt16BE(0) < PROTOCOL_VERSION || !this.session.acquire("udp")) {
					await this.respond(this.header(ID_ERROR, 0, sequence, Buffer.from("unsupported or busy")), sequence, remote.port, remote.address);
					return;
				}
				this.client.packetSize = Math.max(512, Math.min(MAX_PACKET_SIZE, payload.readUInt16BE(2)));
				const response = Buffer.alloc(4);
				response.writeUInt16BE(PROTOCOL_VERSION, 0);
				response.writeUInt16BE(this.client.packetSize, 2);
				await this.respond(this.header(ID_INIT, 0, sequence, response), sequence, remote.port, remote.address);
				this.client.nextSequence = (sequence + 1) & 0xffff;
				return;
			}

			if (id !== ID_FASTBOOT) {return;}
			if (payload.length > 0) {
				this.processingSequences.add(sequence);
				try {
					await this.session.sendToUsb(Buffer.from(payload));
					await this.respond(this.header(ID_FASTBOOT, 0, sequence), sequence, remote.port, remote.address);
					this.client.nextSequence = (sequence + 1) & 0xffff;
				} finally {
					this.processingSequences.delete(sequence);
				}
				return;
			}

			if (this.usbQueue.length) {
				await this.sendNextUsbChunk(sequence, remote.address, remote.port);
			} else {
				this.client.pendingRead = { sequence, address: remote.address, port: remote.port };
			}
		} catch {
			// A later host retry will recover from transient send errors.
		}
	}

	private async sendNextUsbChunk(sequence: number, address: string, port: number) {
		if (!this.client || !this.usbQueue.length) {return;}
		const queued = this.usbQueue[0];
		const maxData = this.client.packetSize - HEADER_SIZE;
		const end = Math.min(queued.data.length, queued.offset + maxData);
		const chunk = queued.data.subarray(queued.offset, end);
		const continuation = end < queued.data.length;
		await this.respond(this.header(ID_FASTBOOT, continuation ? FLAG_CONTINUATION : 0, sequence, chunk), sequence, port, address);
		queued.offset = end;
		this.client.nextSequence = (sequence + 1) & 0xffff;
		this.client.pendingRead = undefined;
		if (!continuation) {
			this.usbQueue.shift();
			queued.resolve();
		}
	}

	async acceptUsbData(data: Buffer): Promise<void> {
		if (!this.client) {return;}
		await new Promise<void>((resolve) => {
			this.usbQueue.push({ data: Buffer.from(data), offset: 0, resolve });
			const pending = this.client?.pendingRead;
			if (pending) {void this.sendNextUsbChunk(pending.sequence, pending.address, pending.port);}
		});
	}

	private expireClient() {
		if (this.client && Date.now() - this.client.lastActive > SESSION_IDLE_MS) {
			this.resetWithoutClient();
		}
	}

	private resetWithoutClient() {
		if (this.client) {this.session.release("udp");}
		this.processingSequences.clear();
		this.client = undefined;
		while (this.usbQueue.length) {this.usbQueue.shift()!.resolve();}
	}

	async stop(): Promise<void> {
		if (this.cleanupTimer) {clearInterval(this.cleanupTimer);}
		this.resetWithoutClient();
		if (this.listening) {
			await new Promise<void>((resolve) => this.socket.close(() => resolve()));
			this.listening = false;
		}
	}
}
