declare module "./wasm_pkg/ashare_wasm.js" {
  const init: () => Promise<void>;
  export default init;
  export function hash_bytes(bytes: Uint8Array): string;
  export function select_chunk_size(totalSize: number, receiverCount: number): number;
  export function encode_metadata_packet(metadataJson: string): Uint8Array;
  export function encode_chunk_packet(
    fileId: string,
    chunkIndex: number,
    offset: number,
    payload: Uint8Array
  ): Uint8Array;
  export function decode_packet(input: Uint8Array): unknown;
  export function encode_resume_offsets(offsetsJson: string): string;
}

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
}

interface FileSystemHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: "directory";
  values(): AsyncIterable<FileSystemHandle>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream {
  write(data: Uint8Array | Blob | string | { type: string; data?: unknown }): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
