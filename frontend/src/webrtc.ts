import { decodePacket, encodeChunkPacket, encodeMetadataPacket, encodeResumeOffsets, selectChunkSize } from "./wasm";
import type { DataMessage, FileNode, FileOffset, SignalMessage, TransferStats } from "./types";

type PeerLink = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  createdAtMs: number;
  sentBytes: number;
  receivedBytes: number;
  transferTotalBytes: number;
  lastStatsEmitMs: number;
};

type FileSink = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
};

type ReceiverFileState = {
  id: string;
  name: string;
  mime: string;
  path: string;
  expectedSize: number;
  totalChunks: number;
  receivedChunks: Map<number, Uint8Array> | null;
  receivedBytes: number;
  hash?: string;
  sink?: FileSink;
};

type SenderOptions = {
  files: FileNode[];
  totalSize: number;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];

const STATS_EMIT_INTERVAL_MS = 150;
const DC_BUFFERED_HIGH_WATER = 256 * 1024;
const DC_BUFFERED_LOW_WATER = 64 * 1024;

export class WebRtcMesh {
  private readonly links = new Map<string, PeerLink>();
  private readonly outboundSignal: (message: SignalMessage) => void;
  private readonly localRole: "sender" | "receiver";
  private readonly sessionId: string;
  private readonly localPeerId: string;
  private readonly senderOptions: SenderOptions | null;
  private readonly receiverStates = new Map<string, ReceiverFileState>();
  private readonly savedOffsets = new Map<string, number>();
  private readonly receiveSinks = new Map<string, FileSink>();
  private readonly cancelledFiles = new Set<string>();

  onPeerConnected: (peerId: string) => void = () => {};
  onPeerDisconnected: (peerId: string) => void = () => {};
  onTransfer: (peerId: string, stats: TransferStats) => void = () => {};
  onFileMetadata: (file: { id: string; name: string; path: string; size: number; mime: string }) => void = () => {};
  onFileReady: (id: string, name: string, blob: Blob, path: string) => void = () => {};
  onFileSaved: (id: string, name: string, path: string) => void = () => {};
  onResumeStateRequired: () => FileOffset[] = () => [];

  constructor(params: {
    sessionId: string;
    localPeerId: string;
    localRole: "sender" | "receiver";
    outboundSignal: (message: SignalMessage) => void;
    senderOptions?: SenderOptions;
  }) {
    this.sessionId = params.sessionId;
    this.localPeerId = params.localPeerId;
    this.localRole = params.localRole;
    this.outboundSignal = params.outboundSignal;
    this.senderOptions = params.senderOptions ?? null;
  }

  async initiateToPeer(peerId: string): Promise<void> {
    const link = this.ensureLink(peerId, true);
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);

    this.outboundSignal({
      kind: "offer",
      from_peer_id: this.localPeerId,
      to_peer_id: peerId,
      sdp: offer.sdp ?? ""
    });
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    if (signal.kind === "offer" && signal.to_peer_id === this.localPeerId) {
      const link = this.ensureLink(signal.from_peer_id, false);
      await link.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.outboundSignal({
        kind: "answer",
        from_peer_id: this.localPeerId,
        to_peer_id: signal.from_peer_id,
        sdp: answer.sdp ?? ""
      });
      return;
    }

    if (signal.kind === "answer" && signal.to_peer_id === this.localPeerId) {
      const link = this.links.get(signal.from_peer_id);
      if (!link) {
        return;
      }
      await link.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      return;
    }

    if (signal.kind === "ice_candidate" && signal.to_peer_id === this.localPeerId) {
      const link = this.links.get(signal.from_peer_id);
      if (!link) {
        return;
      }
      await link.pc.addIceCandidate({
        candidate: signal.candidate,
        sdpMid: signal.sdp_mid,
        sdpMLineIndex: signal.sdp_mline_index
      });
    }
  }

  closePeer(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) {
      return;
    }
    link.dc?.close();
    link.pc.close();
    this.links.delete(peerId);
  }

  closeAll(): void {
    for (const peerId of [...this.links.keys()]) {
      this.closePeer(peerId);
    }
  }

  requestFile(fileId: string): boolean {
    let sent = false;
    const payload: DataMessage = { type: "request_file", file_id: fileId };
    const serialized = JSON.stringify(payload);
    for (const link of this.links.values()) {
      if (link.dc && link.dc.readyState === "open") {
        link.dc.send(serialized);
        sent = true;
      }
    }
    return sent;
  }

  cancelFile(fileId: string): void {
    this.cancelledFiles.add(fileId);
    this.receiverStates.delete(fileId);
    const payload: DataMessage = { type: "cancel_file", file_id: fileId };
    const serialized = JSON.stringify(payload);
    for (const link of this.links.values()) {
      if (link.dc && link.dc.readyState === "open") {
        void safeSend(link.dc, serialized);
      }
    }
  }

  setReceiveSink(fileId: string, sink: FileSink): void {
    this.receiveSinks.set(fileId, sink);
  }

  private ensureLink(peerId: string, createDataChannel: boolean): PeerLink {
    const existing = this.links.get(peerId);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: PeerLink = {
      pc,
      dc: null,
      createdAtMs: Date.now(),
      sentBytes: 0,
      receivedBytes: 0,
      transferTotalBytes: 0,
      lastStatsEmitMs: 0
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      this.outboundSignal({
        kind: "ice_candidate",
        from_peer_id: this.localPeerId,
        to_peer_id: peerId,
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid ?? undefined,
        sdp_mline_index: event.candidate.sdpMLineIndex ?? undefined
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.onPeerConnected(peerId);
        if (this.localRole === "receiver") {
          this.sendResumeHint(peerId);
        }
      }
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.onPeerDisconnected(peerId);
      }
    };

    pc.ondatachannel = (event) => {
      this.bindDataChannel(peerId, link, event.channel);
    };

    if (createDataChannel) {
      // Use fully reliable ordered delivery for file transfer metadata/chunks.
      const dc = pc.createDataChannel("ashare-transfer", {
        ordered: true
      });
      this.bindDataChannel(peerId, link, dc);
    }

    this.links.set(peerId, link);
    return link;
  }

  private bindDataChannel(peerId: string, link: PeerLink, dc: RTCDataChannel): void {
    link.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = DC_BUFFERED_LOW_WATER;

    dc.onopen = () => {
      if (this.localRole === "receiver") {
        this.sendResumeHint(peerId);
      }
    };

    dc.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleDataText(peerId, event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        void this.handleDataBinary(peerId, bytes);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => {
          void this.handleDataBinary(peerId, new Uint8Array(buffer));
        });
      }
    };
  }

  private sendResumeHint(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link?.dc || link.dc.readyState !== "open") {
      return;
    }
    const offsets = this.onResumeStateRequired();
    const payload = encodeResumeOffsets(offsets);
    link.dc.send(payload);
  }

  private handleDataText(peerId: string, text: string): void {
    let data: DataMessage | null = null;
    try {
      data = JSON.parse(text) as DataMessage;
    } catch {
      return;
    }

    if (!data) {
      return;
    }

    if (data.type === "resume_request") {
      for (const offset of data.offsets) {
        this.savedOffsets.set(`${peerId}:${offset.file_id}`, offset.chunk_index);
      }
    }

    if (data.type === "cancel_file" && this.localRole === "sender") {
      this.cancelledFiles.add(data.file_id);
    }

    if (data.type === "request_file" && this.localRole === "sender") {
      this.cancelledFiles.delete(data.file_id);
      void this.sendRequestedFile(peerId, data.file_id);
    }

    if (data.type === "ack") {
      localStorage.setItem(
        `ashare:recv:${this.sessionId}:${data.file_id}`,
        JSON.stringify({ file_id: data.file_id, chunk_index: data.chunk_index })
      );
    }

    if (data.type === "file_done") {
      void this.finalizeReceivedFile(data.file_id);
    }
  }

  private async handleDataBinary(peerId: string, packet: Uint8Array): Promise<void> {
    const data = decodePacket(packet);
    if (!data) {
      return;
    }

    if (data.type === "file_metadata") {
      const sink = this.receiveSinks.get(data.id);
      if (sink) {
        this.receiveSinks.delete(data.id);
      }
      this.receiverStates.set(data.id, {
        id: data.id,
        name: data.name,
        mime: data.mime,
        path: data.path,
        expectedSize: data.size,
        totalChunks: data.total_chunks,
        receivedChunks: sink ? null : new Map<number, Uint8Array>(),
        receivedBytes: 0,
        hash: data.hash,
        sink
      });
      this.onFileMetadata({
        id: data.id,
        name: data.name,
        path: data.path,
        size: data.size,
        mime: data.mime
      });
      const link = this.links.get(peerId);
      if (link) {
        link.receivedBytes = 0;
        link.transferTotalBytes = data.size;
        link.createdAtMs = Date.now();
        link.lastStatsEmitMs = 0;
      }
      return;
    }

    if (data.type === "file_chunk") {
      const state = this.receiverStates.get(data.file_id);
      if (!state) {
        return;
      }
      if (state.sink) {
        await state.sink.write(data.payload);
      } else if (state.receivedChunks) {
        state.receivedChunks.set(data.chunk_index, data.payload);
      }
      state.receivedBytes += data.payload.length;

      const link = this.links.get(peerId);
      if (link) {
        link.receivedBytes += data.payload.length;
      }
      this.emitStats(peerId, false);

      const ack: DataMessage = {
        type: "ack",
        file_id: data.file_id,
        chunk_index: data.chunk_index
      };
      this.links.get(peerId)?.dc?.send(JSON.stringify(ack));
      return;
    }

    if (data.type === "file_done") {
      await this.finalizeReceivedFile(data.file_id);
      return;
    }
  }

  private async finalizeReceivedFile(fileId: string): Promise<void> {
    const state = this.receiverStates.get(fileId);
    if (!state) {
      return;
    }

    if (state.sink) {
      await state.sink.close();
      this.onFileSaved(state.id, state.name, state.path);
    } else if (state.receivedChunks) {
      const ordered: BlobPart[] = [];
      for (let index = 0; index < state.totalChunks; index += 1) {
        const chunk = state.receivedChunks.get(index);
        if (chunk) {
          ordered.push(chunk);
        }
      }
      const blob = new Blob(ordered, { type: state.mime || "application/octet-stream" });
      this.onFileReady(state.id, state.name, blob, state.path);
    }
    this.receiverStates.delete(fileId);
  }

  private emitStats(peerId: string, force: boolean): void {
    const link = this.links.get(peerId);
    if (!link) {
      return;
    }
    const now = Date.now();
    if (!force && now - link.lastStatsEmitMs < STATS_EMIT_INTERVAL_MS) {
      return;
    }
    link.lastStatsEmitMs = now;

    const elapsedSec = Math.max((Date.now() - link.createdAtMs) / 1000, 1);
    const transferred = this.localRole === "sender" ? link.sentBytes : link.receivedBytes;
    const totalBytes = link.transferTotalBytes || this.senderOptions?.totalSize || 0;
    const speed = transferred / elapsedSec;
    const remaining = Math.max(totalBytes - transferred, 0);

    this.onTransfer(peerId, {
      transferredBytes: transferred,
      totalBytes,
      speedMbps: (speed / (1024 * 1024)) * 8,
      etaSeconds: speed > 0 ? remaining / speed : 0
    });
  }

  private async sendRequestedFile(
    peerId: string,
    fileId: string
  ): Promise<void> {
    if (this.localRole !== "sender" || !this.senderOptions) {
      return;
    }

    const link = this.links.get(peerId);
    if (!link?.dc || link.dc.readyState !== "open") {
      return;
    }

    const fileNode = this.senderOptions.files.find((file) => file.id === fileId);
    const file = fileNode?.file;
    if (!fileNode || !file) {
      return;
    }

    const dc = link.dc;
    link.sentBytes = 0;
    link.transferTotalBytes = file.size;
    link.createdAtMs = Date.now();
    link.lastStatsEmitMs = 0;
    const suggestedChunkSize = selectChunkSize(file.size, 1);
    const chunkSize = Math.max(64 * 1024, Math.min(512 * 1024, suggestedChunkSize));
    const totalChunks = Math.ceil(file.size / chunkSize);
    const metadata: DataMessage = {
      type: "file_metadata",
      id: fileNode.id,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      path: fileNode.path,
      chunk_size: chunkSize,
      total_chunks: totalChunks,
      hash: fileNode.hash
    };

    await safeSend(dc, encodeMetadataPacket(metadata));

    const resumeKey = `${peerId}:${fileNode.id}`;
    const startChunk = this.savedOffsets.get(resumeKey) ?? 0;

    for (let chunkIndex = startChunk; chunkIndex < totalChunks; chunkIndex += 1) {
      if (this.cancelledFiles.has(fileId)) {
        this.cancelledFiles.delete(fileId);
        return;
      }
      if (dc.bufferedAmount > DC_BUFFERED_HIGH_WATER) {
        await waitForBufferedAmountLow(dc, DC_BUFFERED_LOW_WATER);
      }
      if (dc.readyState !== "open") {
        return;
      }

      const start = chunkIndex * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const slice = file.slice(start, end);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      const packet = encodeChunkPacket(fileNode.id, chunkIndex, start, bytes);

      await safeSend(dc, packet);
      if (dc.readyState !== "open") {
        return;
      }

      link.sentBytes += bytes.length;
      this.emitStats(peerId, false);
    }

    const done: DataMessage = { type: "file_done", file_id: fileNode.id };
    await safeSend(dc, JSON.stringify(done));
    this.emitStats(peerId, true);
  }
}

function waitForBufferedAmountLow(dc: RTCDataChannel, lowWater: number): Promise<void> {
  if (dc.bufferedAmount <= lowWater || dc.readyState !== "open") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onLow = (): void => {
      dc.removeEventListener("bufferedamountlow", onLow);
      dc.removeEventListener("close", onLow);
      dc.removeEventListener("error", onLow);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", onLow, { once: true });
    dc.addEventListener("close", onLow, { once: true });
    dc.addEventListener("error", onLow, { once: true });
  });
}

async function safeSend(dc: RTCDataChannel, data: string | ArrayBuffer | Uint8Array): Promise<void> {
  const MAX_RETRIES = 8;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (dc.readyState !== "open") {
      return;
    }
    try {
      dc.send(data as string);
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "OperationError") {
        // Internal send buffer full — drain before retrying.
        await waitForBufferedAmountLow(dc, DC_BUFFERED_LOW_WATER);
      } else {
        throw err;
      }
    }
  }
}
