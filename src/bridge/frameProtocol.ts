export const BRIDGE_FRAME_DATA = 1;
export const BRIDGE_FRAME_ACK = 2;
export const BRIDGE_FRAME_HEADER_SIZE = 5;

export type BridgeFrame = {
	type: typeof BRIDGE_FRAME_DATA | typeof BRIDGE_FRAME_ACK;
	id: number;
	payload: Buffer;
};

export function isWebSocketBinary(data: unknown): boolean {
	return typeof data !== "string";
}

export function encodeBridgeFrame(type: BridgeFrame["type"], id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
	const frame = Buffer.allocUnsafe(BRIDGE_FRAME_HEADER_SIZE + payload.length);
	frame.writeUInt8(type, 0);
	frame.writeUInt32BE(id >>> 0, 1);
	payload.copy(frame, BRIDGE_FRAME_HEADER_SIZE);
	return frame;
}

export function decodeBridgeFrame(data: Buffer | ArrayBuffer | Buffer[]): BridgeFrame {
	const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
	if (buffer.length < BRIDGE_FRAME_HEADER_SIZE) {throw new Error("Incomplete bridge frame");}
	const type = buffer.readUInt8(0);
	if (type !== BRIDGE_FRAME_DATA && type !== BRIDGE_FRAME_ACK) {throw new Error(`Unknown bridge frame type ${type}`);}
	return { type, id: buffer.readUInt32BE(1), payload: buffer.subarray(BRIDGE_FRAME_HEADER_SIZE) };
}
