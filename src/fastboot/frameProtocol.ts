export const BRIDGE_PROTOCOL_VERSION = 1;
export * from "../bridge/frameProtocol";

export function encodeFastbootLength(length: number): Buffer {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new Error(`Invalid fastboot message length ${length}`);
	}
	const header = Buffer.alloc(8);
	header.writeBigUInt64BE(BigInt(length));
	return header;
}
