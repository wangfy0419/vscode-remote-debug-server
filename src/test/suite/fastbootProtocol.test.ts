import * as assert from "assert";
import * as dgram from "dgram";
import * as net from "net";
import { decodeBridgeFrame, encodeBridgeFrame, encodeFastbootLength } from "../../fastboot/frameProtocol";
import { FastbootEndpointSession, TcpFastbootEndpoint } from "../../fastboot/tcpEndpoint";
import { UdpFastbootEndpoint } from "../../fastboot/udpEndpoint";

class FakeSession implements FastbootEndpointSession {
	owner?: "tcp" | "udp";
	writes: Buffer[] = [];
	acquire(owner: "tcp" | "udp") { if (this.owner && this.owner !== owner) {return false;} this.owner = owner; return true; }
	release(owner: "tcp" | "udp") { if (this.owner === owner) {this.owner = undefined;} }
	async sendToUsb(data: Buffer) { this.writes.push(Buffer.from(data)); }
}

function readExact(socket: net.Socket, length: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const onData = (data: Buffer) => {
			buffer = Buffer.concat([buffer, data]);
			if (buffer.length >= length) {
				socket.off("data", onData);
				resolve(buffer.subarray(0, length));
			}
		};
		socket.on("data", onData);
		socket.once("error", reject);
	});
}

function udpPacket(id: number, flags: number, sequence: number, data = Buffer.alloc(0)): Buffer {
	const packet = Buffer.alloc(4 + data.length);
	packet[0] = id;
	packet[1] = flags;
	packet.writeUInt16BE(sequence, 2);
	data.copy(packet, 4);
	return packet;
}

function udpExchange(socket: dgram.Socket, port: number, packet: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("UDP response timeout")), 2_000);
		socket.once("message", (response) => { clearTimeout(timer); resolve(response); });
		socket.send(packet, port, "127.0.0.1", (error) => { if (error) { clearTimeout(timer); reject(error); } });
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {throw new Error("Condition timed out");}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

suite("Fastboot protocol", () => {
	test("bridge frame and TCP length codecs", () => {
		const payload = Buffer.from("getvar:product");
		assert.deepStrictEqual(decodeBridgeFrame(encodeBridgeFrame(1, 42, payload)), { type: 1, id: 42, payload });
		assert.strictEqual(encodeFastbootLength(0x100000).readBigUInt64BE(), 0x100000n);
	});

	test("TCP handshake, fragmented input and large response", async () => {
		const session = new FakeSession();
		const endpoint = new TcpFastbootEndpoint(session);
		const port = await endpoint.start();
		const socket = net.createConnection(port, "127.0.0.1");
		await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		socket.write("FB");
		socket.write("01");
		assert.strictEqual((await readExact(socket, 4)).toString(), "FB01");

		const command = Buffer.from("getvar:product");
		const framed = Buffer.concat([encodeFastbootLength(command.length), command]);
		socket.write(framed.subarray(0, 5));
		socket.write(framed.subarray(5));
		await waitFor(() => session.writes.length === 1);
		assert.deepStrictEqual(session.writes, [command]);

		const download = Buffer.alloc(2 * 1024 * 1024 + 7, 0xa5);
		socket.write(Buffer.concat([encodeFastbootLength(download.length), download]));
		await waitFor(() => session.writes.length === 4);
		assert.deepStrictEqual(session.writes.slice(1).map((part) => part.length), [1024 * 1024, 1024 * 1024, 7]);
		assert.deepStrictEqual(Buffer.concat(session.writes.slice(1)), download);

		const response = Buffer.alloc(1024 * 1024 + 7, 0x5a);
		const pending = readExact(socket, response.length + 8);
		await endpoint.acceptUsbData(response);
		const received = await pending;
		assert.strictEqual(Number(received.readBigUInt64BE(0)), response.length);
		assert.deepStrictEqual(received.subarray(8), response);
		socket.destroy();
		await endpoint.stop();
	});

	test("UDP initialization, continuation and device response", async () => {
		const session = new FakeSession();
		const endpoint = new UdpFastbootEndpoint(session);
		const port = await endpoint.start();
		const socket = dgram.createSocket("udp4");
		await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));

		const query = await udpExchange(socket, port, udpPacket(1, 0, 0));
		assert.strictEqual(query[0], 1);
		assert.strictEqual(query.readUInt16BE(4), 0);
		const initData = Buffer.from([0, 1, 0x20, 0]);
		const init = await udpExchange(socket, port, udpPacket(2, 0, 0, initData));
		assert.deepStrictEqual(init.subarray(4), initData);

		await udpExchange(socket, port, udpPacket(3, 1, 1, Buffer.from("getvar:")));
		await udpExchange(socket, port, udpPacket(3, 0, 2, Buffer.from("product")));
		assert.strictEqual(Buffer.concat(session.writes).toString(), "getvar:product");

		const deviceResponse = endpoint.acceptUsbData(Buffer.from("OKAYdemo"));
		const response = await udpExchange(socket, port, udpPacket(3, 0, 3));
		await deviceResponse;
		assert.strictEqual(response.subarray(4).toString(), "OKAYdemo");

		socket.close();
		await endpoint.stop();
	});

	test("TCP and UDP endpoints can reuse reserved ports after a device reconnect", async () => {
		const firstSession = new FakeSession();
		const firstTcp = new TcpFastbootEndpoint(firstSession);
		const firstUdp = new UdpFastbootEndpoint(firstSession);
		const tcpPort = await firstTcp.start();
		const udpPort = await firstUdp.start();
		await Promise.all([firstTcp.stop(), firstUdp.stop()]);

		const secondSession = new FakeSession();
		const secondTcp = new TcpFastbootEndpoint(secondSession);
		const secondUdp = new UdpFastbootEndpoint(secondSession);
		assert.strictEqual(await secondTcp.start(tcpPort), tcpPort);
		assert.strictEqual(await secondUdp.start(udpPort), udpPort);
		await Promise.all([secondTcp.stop(), secondUdp.stop()]);
	});
});
