import * as assert from "assert";
import * as net from "net";
import WebSocket from "ws";
import {
	BRIDGE_FRAME_ACK,
	BRIDGE_FRAME_DATA,
	decodeBridgeFrame,
	encodeBridgeFrame,
	isWebSocketBinary,
} from "../../bridge/frameProtocol";
import { DEFAULT_SERIAL_TCP_PORT, SERIAL_BRIDGE_PROTOCOL_VERSION, SerialBridgeServer } from "../../serial/bridgeServer";

type SerialHandshakeResponse = {
	type: "serial-handshake";
	version: number;
	tcpPort: number;
	tcpEndpoint: string;
};

function onceMessage(ws: WebSocket): Promise<WebSocket.Data> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			ws.off("message", onMessage);
			ws.off("error", onError);
			ws.off("close", onClose);
		};
		const onMessage = (data: WebSocket.Data) => {cleanup(); resolve(data);};
		const onError = (error: Error) => {cleanup(); reject(error);};
		const onClose = () => {cleanup(); reject(new Error("WebSocket closed before message"));};
		ws.once("message", onMessage);
		ws.once("error", onError);
		ws.once("close", onClose);
	});
}

function onceSocketData(socket: net.Socket): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		socket.once("data", (data) => resolve(Buffer.from(data)));
		socket.once("error", reject);
	});
}

async function connectPeer(server: SerialBridgeServer, deviceId = "usb:0403:6001:A1"): Promise<{ ws: WebSocket; handshake: SerialHandshakeResponse }> {
	const url = new URL(await server.start(0));
	url.protocol = "ws:";
	const ws = new WebSocket(url.toString());
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const response = onceMessage(ws);
	ws.send(JSON.stringify({
		type: "serial-handshake",
		version: SERIAL_BRIDGE_PROTOCOL_VERSION,
		deviceId,
		name: "Mock FTDI",
		path: "COM3",
		baudRate: 115200,
	}));
	const message = await response;
	assert.strictEqual(isWebSocketBinary(message), false);
	return { ws, handshake: JSON.parse(message.toString()) as SerialHandshakeResponse };
}

async function connectTcp(port: number): Promise<net.Socket> {
	const socket = net.createConnection({ host: "127.0.0.1", port });
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return socket;
}

suite("Serial WebSocket bridge", () => {
	test("prefers the stable default TCP port for the first serial device", async () => {
		const server = new SerialBridgeServer();
		let ws: WebSocket | undefined;
		try {
			const peer = await connectPeer(server);
			ws = peer.ws;
			assert.strictEqual(peer.handshake.tcpPort, DEFAULT_SERIAL_TCP_PORT);
			assert.strictEqual(peer.handshake.tcpEndpoint, `127.0.0.1:${DEFAULT_SERIAL_TCP_PORT}`);
		} finally {
			ws?.close();
			await server.stop();
		}
	});

	test("falls back to an available TCP port when the default is occupied", async () => {
		const occupied = net.createServer();
		await new Promise<void>((resolve, reject) => {
			occupied.once("error", reject);
			occupied.listen(DEFAULT_SERIAL_TCP_PORT, "127.0.0.1", resolve);
		});
		const server = new SerialBridgeServer();
		let ws: WebSocket | undefined;
		try {
			const peer = await connectPeer(server);
			ws = peer.ws;
			assert.notStrictEqual(peer.handshake.tcpPort, DEFAULT_SERIAL_TCP_PORT);
			assert.ok(peer.handshake.tcpPort > 0);
		} finally {
			ws?.close();
			await server.stop();
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});

	test("round-trips TCP and Serial data with acknowledgements", async () => {
		const server = new SerialBridgeServer();
		let ws: WebSocket | undefined;
		let socket: net.Socket | undefined;
		try {
			const peer = await connectPeer(server);
			ws = peer.ws;
			socket = await connectTcp(peer.handshake.tcpPort);
			ws.send(JSON.stringify({ type: "serial-state", attached: true, path: "COM3" }));

			const tcpFrame = onceMessage(ws);
			socket.write(Buffer.from("from-tcp"));
			const frame = decodeBridgeFrame(await tcpFrame as Buffer);
			assert.strictEqual(frame.type, BRIDGE_FRAME_DATA);
			assert.strictEqual(frame.payload.toString(), "from-tcp");
			ws.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));

			const serialData = onceSocketData(socket);
			const ack = onceMessage(ws);
			ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, 77, Buffer.from("from-serial")));
			assert.strictEqual((await serialData).toString(), "from-serial");
			assert.deepStrictEqual(decodeBridgeFrame(await ack as Buffer), { type: BRIDGE_FRAME_ACK, id: 77, payload: Buffer.alloc(0) });
		} finally {
			socket?.destroy();
			ws?.close();
			await server.stop();
		}
	});

	test("pauses TCP while detached and retains the endpoint across a peer reconnect", async () => {
		const server = new SerialBridgeServer();
		let first: WebSocket | undefined;
		let second: WebSocket | undefined;
		let socket: net.Socket | undefined;
		try {
			const peer = await connectPeer(server);
			first = peer.ws;
			socket = await connectTcp(peer.handshake.tcpPort);
			first.send(JSON.stringify({ type: "serial-state", attached: false }));
			let delivered = false;
			first.once("message", () => {delivered = true;});
			socket.write(Buffer.from("held"));
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.strictEqual(delivered, false);
			const heldFrame = onceMessage(first);
			first.send(JSON.stringify({ type: "serial-state", attached: true, path: "COM9" }));
			const frame = decodeBridgeFrame(await heldFrame as Buffer);
			assert.strictEqual(frame.payload.toString(), "held");
			first.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));

			socket.destroy();
			first.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			const reconnected = await connectPeer(server);
			second = reconnected.ws;
			assert.strictEqual(reconnected.handshake.tcpPort, peer.handshake.tcpPort);
		} finally {
			socket?.destroy();
			first?.close();
			second?.close();
			await server.stop();
		}
	});

	test("rejects a second TCP consumer", async () => {
		const server = new SerialBridgeServer();
		let ws: WebSocket | undefined;
		let first: net.Socket | undefined;
		let second: net.Socket | undefined;
		try {
			const peer = await connectPeer(server);
			ws = peer.ws;
			first = await connectTcp(peer.handshake.tcpPort);
			second = await connectTcp(peer.handshake.tcpPort);
			await new Promise<void>((resolve) => second!.once("close", () => resolve()));
			assert.strictEqual(second.destroyed, true);
		} finally {
			first?.destroy();
			second?.destroy();
			ws?.close();
			await server.stop();
		}
	});

	test("allocates independent TCP endpoints for multiple serial devices", async () => {
		const server = new SerialBridgeServer();
		let first: WebSocket | undefined;
		let second: WebSocket | undefined;
		try {
			const firstPeer = await connectPeer(server, "path:COM3");
			first = firstPeer.ws;
			const secondPeer = await connectPeer(server, "path:COM4");
			second = secondPeer.ws;
			assert.notStrictEqual(firstPeer.handshake.tcpPort, secondPeer.handshake.tcpPort);
		} finally {
			first?.close();
			second?.close();
			await server.stop();
		}
	});
});
