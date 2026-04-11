export type PeerRole = "sender" | "receiver";

export interface SessionMetadata {
  name: string;
  file_count: number;
  total_size: number;
  has_pin: boolean;
  public_presence: boolean;
  created_at: number;
  expires_at: number;
  network_hint?: string;
}

export interface FileNode {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  hash?: string;
  children: FileNode[];
  is_dir: boolean;
  file?: File;
}

export interface FileOffset {
  file_id: string;
  chunk_index: number;
}

export type SignalMessage =
  | { kind: "hello"; role: PeerRole; peer_id: string; session_id: string }
  | { kind: "sender_online"; metadata: SessionMetadata }
  | { kind: "peer_joined"; peer_id: string; network_hint?: string }
  | { kind: "peer_left"; peer_id: string }
  | { kind: "offer"; from_peer_id: string; to_peer_id: string; sdp: string }
  | { kind: "answer"; from_peer_id: string; to_peer_id: string; sdp: string }
  | {
      kind: "ice_candidate";
      from_peer_id: string;
      to_peer_id: string;
      candidate: string;
      sdp_mid?: string;
      sdp_mline_index?: number;
    }
  | { kind: "transfer_intent"; to_peer_id: string; tree: FileNode[]; total_size: number }
  | { kind: "approval_request"; peer_id: string; device_label: string }
  | { kind: "approval_response"; peer_id: string; approved: boolean; reason?: string }
  | { kind: "resume_state"; peer_id: string; file_offsets: FileOffset[] }
  | { kind: "error"; code: string; message: string }
  | { kind: "keep_alive" };

export type DataMessage =
  | {
      type: "file_metadata";
      id: string;
      name: string;
      size: number;
      mime: string;
      path: string;
      chunk_size: number;
      total_chunks: number;
      hash?: string;
    }
  | {
      type: "file_chunk";
      file_id: string;
      chunk_index: number;
      offset: number;
      payload_len: number;
      payload: Uint8Array;
    }
  | { type: "file_done"; file_id: string }
  | { type: "transfer_done" }
  | { type: "ack"; file_id: string; chunk_index: number }
  | { type: "request_file"; file_id: string }
  | { type: "resume_request"; offsets: FileOffset[] };

export interface TransferStats {
  transferredBytes: number;
  totalBytes: number;
  speedMbps: number;
  etaSeconds: number;
}

export interface PresenceSession {
  session_id: string;
  name: string;
  file_count: number;
  total_size: number;
  expires_at: number;
  network_hint?: string;
}
