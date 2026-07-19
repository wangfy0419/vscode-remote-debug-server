import * as assert from "assert";
import WebSocket from "ws";
import { ContainerShellServer, validateContainerShellConfiguration } from "../../containerShell/server";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function nextJson(ws: WebSocket): Promise<any> {
	return new Promise((resolve, reject) => {
		ws.once("message", (data: WebSocket.Data) => {
			try {resolve(JSON.parse(data.toString()));} catch (error) {reject(error);}
		});
		ws.once("error", reject);
	});
}

function collectJson(ws: WebSocket, send: () => void, done: (messages: any[]) => boolean): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const messages: any[] = [];
		const onMessage = (data: WebSocket.Data) => {
			try {
				messages.push(JSON.parse(data.toString()));
				if (done(messages)) {
					ws.off("message", onMessage);
					resolve(messages);
				}
			} catch (error) {reject(error);}
		};
		ws.on("message", onMessage);
		ws.once("error", reject);
		send();
	});
}

suite("Container Shell server", () => {
	test("validates shell path and working directory", () => {
		assert.doesNotThrow(() => validateContainerShellConfiguration({ shellPath: "/bin/bash", cwd: process.cwd() }));
		assert.throws(() => validateContainerShellConfiguration({ shellPath: "/missing-shell", cwd: process.cwd() }), /does not exist/);
		assert.throws(() => validateContainerShellConfiguration({ shellPath: "/bin/bash", cwd: "/missing-cwd" }), /does not exist/);
	});

	test("streams stdout and stderr and returns a non-zero exit code", async () => {
		const server = new ContainerShellServer({ shellPath: "/bin/bash", cwd: process.cwd() }, logger);
		const url = new URL(await server.start(0));
		url.protocol = "ws:";
		const ws = new WebSocket(url.toString());
		await new Promise<void>((resolve, reject) => {ws.once("open", resolve); ws.once("error", reject);});
		try {
			assert.strictEqual((await nextJson(ws)).type, "ready");
			const messages = await collectJson(
				ws,
				() => ws.send(JSON.stringify({ type: "exec", id: "one", command: "printf out; printf err >&2; exit 7" })),
				(values) => values.some((message) => message.type === "exit"),
			);
			assert.strictEqual(Buffer.from(messages.find((message) => message.type === "stdout").data, "base64").toString(), "out");
			assert.strictEqual(Buffer.from(messages.find((message) => message.type === "stderr").data, "base64").toString(), "err");
			assert.strictEqual(messages.find((message) => message.type === "exit").exitCode, 7);
		} finally {
			ws.close();
			await server.stop();
		}
	});

	test("rejects duplicate ids while allowing concurrent commands", async () => {
		const server = new ContainerShellServer({ shellPath: "/bin/bash", cwd: process.cwd() }, logger);
		const url = new URL(await server.start(0));
		url.protocol = "ws:";
		const ws = new WebSocket(url.toString());
		await new Promise<void>((resolve, reject) => {ws.once("open", resolve); ws.once("error", reject);});
		try {
			await nextJson(ws);
			const messages = await collectJson(ws, () => {
				ws.send(JSON.stringify({ type: "exec", id: "same", command: "sleep 1" }));
				ws.send(JSON.stringify({ type: "exec", id: "same", command: "true" }));
			}, (values) => values.some((message) => message.code === "DUPLICATE_ID"));
			const duplicate = messages.find((message) => message.code === "DUPLICATE_ID");
			assert.strictEqual(duplicate.id, "same");
			ws.send(JSON.stringify({ type: "cancel", id: "same" }));
		} finally {
			ws.close();
			await server.stop();
		}
	});
});
