import * as net from "net";
import { encodeFastbootLength } from "./frameProtocol";

const HANDSHAKE = Buffer.from("FB01", "ascii");
const MAX_MESSAGE_SIZE = 0xffff_ffff;
const BRIDGE_CHUNK_SIZE = 1024 * 1024;

export type EndpointOwner = "tcp" | "udp";

export interface FastbootEndpointSession {
	acquire(owner: EndpointOwner): boolean;
	release(owner: EndpointOwner): void;
	sendToUsb(data: Buffer): Promise<void>;
}

export class TcpFastbootEndpoint {
	private readonly server: net.Server;
	private socket?: net.Socket;
	private input = Buffer.alloc(0);
	private handshakeComplete = false;
	private processing = false;
	private messageBytesLeft?: number;

	constructor(private readonly session: FastbootEndpointSession) {
		this.server = net.createServer((socket) => this.handleConnection(socket));
	}

	async start(port = 0): Promise<number> {
		return await new Promise<number>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve((this.server.address() as net.AddressInfo).port);
			});
		});
	}

	private handleConnection(socket: net.Socket) {
		if (this.socket || !this.session.acquire("tcp")) {
			socket.destroy(new Error("Fastboot device is busy"));
			return;
		}

		this.socket = socket;
		this.input = Buffer.alloc(0);
		this.handshakeComplete = false;
		this.messageBytesLeft = undefined;
		socket.setNoDelay(true);
		socket.setTimeout(2_000, () => {
			if (!this.handshakeComplete) {socket.destroy(new Error("Fastboot handshake timed out"));}
		});
		socket.on("data", (data) => {
			this.input = Buffer.concat([this.input, data]);
			void this.processInput();
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			if (this.socket === socket) {
				this.socket = undefined;
				this.input = Buffer.alloc(0);
				this.session.release("tcp");
			}
		});
	}

	private async processInput() {
		if (this.processing || !this.socket) {return;}
		this.processing = true;
		this.socket.pause();
		try {
			if (!this.handshakeComplete) {
				if (this.input.length < 4) {return;}
				const handshake = this.input.subarray(0, 4);
				this.input = this.input.subarray(4);
				const version = Number(handshake.subarray(2).toString("ascii"));
				if (handshake.subarray(0, 2).toString("ascii") !== "FB" || !Number.isInteger(version) || version < 1) {
					this.socket.destroy(new Error("Unsupported fastboot TCP handshake"));
					return;
				}
				this.socket.setTimeout(0);
				this.socket.write(HANDSHAKE);
				this.handshakeComplete = true;
			}

			while (this.socket) {
				if (this.messageBytesLeft === undefined) {
					if (this.input.length < 8) {break;}
					const length = Number(this.input.readBigUInt64BE(0));
					if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_SIZE) {
						this.socket.destroy(new Error(`Invalid fastboot TCP message length ${length}`));
						return;
					}
					this.input = this.input.subarray(8);
					this.messageBytesLeft = length;
					if (length === 0) {
						await this.session.sendToUsb(Buffer.alloc(0));
						this.messageBytesLeft = undefined;
						continue;
					}
				}

				const chunkSize = Math.min(BRIDGE_CHUNK_SIZE, this.messageBytesLeft);
				if (this.input.length < chunkSize) {break;}
				const chunk = Buffer.from(this.input.subarray(0, chunkSize));
				this.input = this.input.subarray(chunkSize);
				this.messageBytesLeft -= chunkSize;
				await this.session.sendToUsb(chunk);
				if (this.messageBytesLeft === 0) {this.messageBytesLeft = undefined;}
			}
		} catch (error) {
			this.socket?.destroy(error as Error);
		} finally {
			this.processing = false;
			this.socket?.resume();
			if (this.socket && this.hasCompleteInput()) {
				void this.processInput();
			}
		}
	}

	private hasCompleteInput(): boolean {
		if (!this.handshakeComplete) {return this.input.length >= 4;}
		if (this.messageBytesLeft !== undefined) {
			return this.input.length >= Math.min(BRIDGE_CHUNK_SIZE, this.messageBytesLeft);
		}
		return this.input.length >= 8;
	}

	async acceptUsbData(data: Buffer): Promise<void> {
		const socket = this.socket;
		if (!socket || !this.handshakeComplete || socket.destroyed) {return;}
		await new Promise<void>((resolve, reject) => {
			socket.write(Buffer.concat([encodeFastbootLength(data.length), data]), (error) => error ? reject(error) : resolve());
		});
	}

	async stop(): Promise<void> {
		this.socket?.destroy();
		if (this.server.listening) {
			await new Promise<void>((resolve) => this.server.close(() => resolve()));
		}
	}
}
