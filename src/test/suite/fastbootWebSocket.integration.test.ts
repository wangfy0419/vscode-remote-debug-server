import * as assert from "assert";
import { execFile } from "child_process";
import WebSocket from "ws";
import { FastbootBridgeServer } from "../../fastboot/bridgeServer";
import {
	BRIDGE_FRAME_ACK,
	BRIDGE_FRAME_DATA,
	BRIDGE_PROTOCOL_VERSION,
	decodeBridgeFrame,
	encodeBridgeFrame,
	isWebSocketBinary,
} from "../../fastboot/frameProtocol";

type Handshake = {
	type: "fastboot-handshake";
	version: number;
	tcpSerial: string;
	udpSerial: string;
};

function onceMessage(ws: WebSocket): Promise<WebSocket.Data> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onClose = () => { cleanup(); reject(new Error("WebSocket closed before the expected message")); };
		const onMessage = (data: WebSocket.Data) => { cleanup(); resolve(data); };
		const cleanup = () => {
			ws.off("error", onError);
			ws.off("close", onClose);
			ws.off("message", onMessage);
		};
		ws.once("error", onError);
		ws.once("close", onClose);
		ws.once("message", onMessage);
	});
}

async function connectUsbPeer(server: FastbootBridgeServer): Promise<{ ws: WebSocket; handshake: Handshake }> {
	const url = new URL(await server.start(0));
	url.protocol = "ws:";
	const ws = new WebSocket(url.toString());
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const response = onceMessage(ws);
	ws.send(JSON.stringify({ type: "fastboot-handshake", version: BRIDGE_PROTOCOL_VERSION, name: "Mock WebUSB", serial: "mock-usb-1" }));
	const message = await response;
	assert.strictEqual(isWebSocketBinary(message), false);
	return { ws, handshake: JSON.parse(message.toString()) as Handshake };
}

function runFastboot(path: string, serial: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(path, ["-s", serial, "getvar", "all"], { timeout: 10_000 }, (error, stdout, stderr) => {
			if (error) {reject(new Error(`${error.message}\n${stdout}\n${stderr}`));}
			else {resolve({ stdout, stderr });}
		});
	});
}

suite("Fastboot WebSocket integration", () => {
	test("confirms an explicit remote fastboot disconnect before bridge teardown", async () => {
		const invocations: string[][] = [];
		const server = new FastbootBridgeServer({
			fastbootPath: "/mock/fastboot",
			autoRegister: true,
			commandRunner: async (_path, args) => {
				invocations.push([...args]);
				return "";
			},
		});
		let ws: WebSocket | undefined;
		try {
			const peer = await connectUsbPeer(server);
			ws = peer.ws;
			assert.deepStrictEqual(invocations, [["connect", peer.handshake.tcpSerial]]);

			const response = onceMessage(ws);
			ws.send(JSON.stringify({ type: "fastboot-disconnect" }));
			const result = JSON.parse((await response).toString());
			assert.deepStrictEqual(result, { type: "fastboot-disconnect-result", success: true });
			assert.deepStrictEqual(invocations, [
				["connect", peer.handshake.tcpSerial],
				["disconnect", peer.handshake.tcpSerial],
			]);

			const closed = new Promise<void>((resolve) => ws!.once("close", resolve));
			ws.close();
			await closed;
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.strictEqual(invocations.length, 2, "bridge cleanup must not repeat a confirmed disconnect");
		} finally {
			ws?.close();
			await server.stop();
		}
	});

	test("accepts a Fastboot WebSocket connection without a token", async () => {
		const server = new FastbootBridgeServer({ fastbootPath: "fastboot", autoRegister: false });
		let ws: WebSocket | undefined;
		try {
			const bridgeUrl = new URL(await server.start(0));
			assert.strictEqual(bridgeUrl.pathname, "/fastboot");
			assert.strictEqual(bridgeUrl.search, "");

			const peer = await connectUsbPeer(server);
			ws = peer.ws;
			assert.strictEqual(peer.handshake.type, "fastboot-handshake");
			assert.strictEqual(peer.handshake.version, BRIDGE_PROTOCOL_VERSION);
		} finally {
			ws?.close();
			await server.stop();
		}
	});

	test("real fastboot CLI round-trips through TCP and WebSocket to a mock WebUSB peer", async function () {
		this.timeout(15_000);
		const fastboot = process.env.FASTBOOT_BINARY;
		if (!fastboot) {this.skip(); return;}

		const server = new FastbootBridgeServer({ fastbootPath: fastboot, autoRegister: false });
		let ws: WebSocket | undefined;
		try {
			const peer = await connectUsbPeer(server);
			ws = peer.ws;
			assert.strictEqual(peer.handshake.type, "fastboot-handshake");
			assert.strictEqual(peer.handshake.version, BRIDGE_PROTOCOL_VERSION);

			const commandReceived = new Promise<Buffer>((resolve, reject) => {
				ws!.on("message", (raw: WebSocket.Data) => {
					if (!isWebSocketBinary(raw)) {return;}
					try {
						const frame = decodeBridgeFrame(raw as Buffer);
						if (frame.type !== BRIDGE_FRAME_DATA) {return;}
						ws!.send(encodeBridgeFrame(BRIDGE_FRAME_ACK, frame.id));
						resolve(Buffer.from(frame.payload));
					} catch (error) {reject(error);}
				});
			});

			const invocation = runFastboot(fastboot, peer.handshake.tcpSerial);
			assert.strictEqual((await commandReceived).toString("ascii"), "getvar:all");

			ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, 100, Buffer.from("INFOproduct:mock")));
			ws.send(encodeBridgeFrame(BRIDGE_FRAME_DATA, 101, Buffer.from("OKAY")));
			const result = await invocation;
			assert.match(result.stderr, /product:\s*mock/);
			assert.match(result.stderr, /Finished\. Total time:/);
		} finally {
			ws?.close();
			await server.stop();
		}
	});
});
