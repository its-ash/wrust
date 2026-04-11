import type { DataMessage, FileOffset } from "./types";
import initWasmModule, * as wasmModule from "./wasm_pkg/wrust_wasm.js";

type WasmModule = {
  hash_bytes: (bytes: Uint8Array) => string;
  select_chunk_size: (totalSize: bigint | number, receiverCount: number) => number;
  encode_metadata_packet: (metadataJson: string) => Uint8Array;
  encode_chunk_packet: (
    fileId: string,
    chunkIndex: number,
    offset: bigint | number,
    payload: Uint8Array
  ) => Uint8Array;
  decode_packet: (input: Uint8Array) => unknown;
  encode_resume_offsets: (offsetsJson: string) => string;
};

let wasmRef: WasmModule | null = null;

export async function initWasm(): Promise<void> {
  if (wasmRef) {
    return;
  }

  try {
    if (typeof initWasmModule === "function") {
      await initWasmModule();
    }
    wasmRef = wasmModule as unknown as WasmModule;
  } catch {
    wasmRef = null;
  }
}

export function hashBytes(bytes: Uint8Array): string {
  if (wasmRef) {
    return wasmRef.hash_bytes(bytes);
  }
  return Array.from(bytes.slice(0, 16))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

export function selectChunkSize(totalSize: number, receiverCount: number): number {
  if (wasmRef) {
    try {
      return wasmRef.select_chunk_size(BigInt(Math.max(0, Math.trunc(totalSize))), receiverCount);
    } catch {
      // Fall back to numeric call for builds where wasm-bindgen emitted number signatures.
      return wasmRef.select_chunk_size(totalSize, receiverCount);
    }
  }
  if (totalSize > 4 * 1024 ** 3) {
    return 256 * 1024;
  }
  if (totalSize > 512 * 1024 ** 2) {
    return 128 * 1024;
  }
  return receiverCount > 3 ? 32 * 1024 : 64 * 1024;
}

export function encodeMetadataPacket(data: DataMessage): Uint8Array {
  // Keep packet encoding in JS to avoid runtime format mismatches across
  // different wasm-bindgen builds between sender and receiver.
  const body = new TextEncoder().encode(JSON.stringify(data));
  const out = new Uint8Array(body.length + 1);
  out[0] = 1;
  out.set(body, 1);
  return out;
}

export function encodeChunkPacket(
  fileId: string,
  chunkIndex: number,
  offset: number,
  payload: Uint8Array
): Uint8Array {
  // Use a deterministic JS packet encoder here to avoid wasm BigInt binding
  // incompatibilities across different generated builds.
  const header = new TextEncoder().encode(
    JSON.stringify({ file_id: fileId, chunk_index: chunkIndex, offset, payload_len: payload.length })
  );
  const out = new Uint8Array(1 + 4 + header.length + payload.length);
  out[0] = 2;
  new DataView(out.buffer).setUint32(1, header.length, true);
  out.set(header, 5);
  out.set(payload, 5 + header.length);
  return out;
}

export function decodePacket(packet: Uint8Array): DataMessage | null {
  if (!packet.length) {
    return null;
  }

  if (packet[0] === 1) {
    return JSON.parse(new TextDecoder().decode(packet.slice(1))) as DataMessage;
  }

  if (packet[0] === 2 && packet.length > 5) {
    const headerLength = new DataView(packet.buffer, packet.byteOffset).getUint32(1, true);
    const headerEnd = 5 + headerLength;
    const header = JSON.parse(new TextDecoder().decode(packet.slice(5, headerEnd))) as {
      file_id: string;
      chunk_index: number;
      offset: number;
      payload_len: number;
    };

    return {
      type: "file_chunk",
      file_id: header.file_id,
      chunk_index: header.chunk_index,
      offset: header.offset,
      payload_len: header.payload_len,
      payload: packet.slice(headerEnd)
    };
  }

  return null;
}

export function encodeResumeOffsets(offsets: FileOffset[]): string {
  if (wasmRef) {
    return wasmRef.encode_resume_offsets(JSON.stringify(offsets));
  }
  return JSON.stringify({ type: "resume_request", offsets });
}
