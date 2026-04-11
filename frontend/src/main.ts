import { flattenTree, formatBytes, pickFolderTree } from "./file-system";
import { SignalingClient } from "./signaling";
import type { FileNode, FileOffset, SignalMessage } from "./types";
import { initWasm } from "./wasm";
import { WebRtcMesh } from "./webrtc";
import "./styles.css";

type AppMode = "send" | "receive";

type SenderState = {
  tree: FileNode[];
  flatFiles: FileNode[];
  totalSize: number;
  fileCount: number;
  scanning: boolean;
  scanFileCount: number;
  scanTotalSize: number;
  sessionId?: string;
  senderPeerId?: string;
  mesh?: WebRtcMesh;
};

type ReceiverState = {
  sessionId?: string;
  receiverPeerId?: string;
  mesh?: WebRtcMesh;
  connected: boolean;
  sharedTree: FileNode[];
  sharedFiles: Array<{
    id: string;
    name: string;
    path: string;
    size: number;
    mime: string;
    saved: boolean;
    requested: boolean;
    url?: string;
  }>;
};

const baseUrl = (import.meta.env.VITE_SIGNAL_BASE as string | undefined) ?? window.location.origin;
const networkHint = window.location.hostname;
const signaling = new SignalingClient(baseUrl);

const senderState: SenderState = {
  tree: [],
  flatFiles: [],
  totalSize: 0,
  fileCount: 0,
  scanning: false,
  scanFileCount: 0,
  scanTotalSize: 0
};

const receiverState: ReceiverState = {
  connected: false,
  sharedTree: [],
  sharedFiles: []
};

let mode: AppMode = "send";

void bootstrap();

async function bootstrap(): Promise<void> {
  await initWasm();
  render();
  bindGlobalHandlers();
}

function bindGlobalHandlers(): void {
  signaling.onMessage((msg) => {
    void onSignalMessage(msg);
  });

  signaling.onClose(() => {
    receiverState.connected = false;
    if (mode === "receive") {
      render();
    }
    setStatus("Signal disconnected.");
  });
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    return;
  }

  app.innerHTML = `
    <main class="shell">
      <header class="brand">
        <div class="geo-logo" aria-hidden="true">
          <span class="shape shape-circle"></span>
          <span class="shape shape-square"></span>
          <span class="shape shape-triangle"></span>
        </div>
        <h1>Ashare</h1>
        <p>Browser-native global P2P sharing powered by WebRTC and Rust/WASM.</p>
      </header>

      <section class="mode-switch">
        <button data-mode="send" class="mode-btn ${mode === "send" ? "active" : ""}">Send</button>
        <button data-mode="receive" class="mode-btn ${mode === "receive" ? "active" : ""}">Receive</button>
      </section>

      <section id="content" class="panel panel-${mode}"></section>
      <section class="status-bar" id="status-bar">Ready.</section>
    </main>
  `;

  const content = document.querySelector<HTMLDivElement>("#content");
  if (!content) {
    return;
  }

  if (mode === "send") {
    content.innerHTML = sendHtml();
  } else {
    content.innerHTML = receiveHtml();
  }

  bindModeButtons();
  bindModeHandlers();
}

function bindModeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((button) => {
    button.onclick = () => {
      mode = button.dataset.mode as AppMode;
      render();
    };
  });
}

function bindModeHandlers(): void {
  if (mode === "send") {
    bindSendHandlers();
    return;
  }

  bindReceiveHandlers();
}

function sendHtml(): string {
  const scanningMeta = senderState.scanning
    ? `Scanning... ${senderState.scanFileCount} files • ${formatBytes(senderState.scanTotalSize)}`
    : senderState.fileCount > 0
      ? `${senderState.fileCount} files • ${formatBytes(senderState.totalSize)}`
      : "No folder selected";

  return `
    <div class="stack">
      <h2>Send Files</h2>

      <div class="button-row">
        <button id="pick-folder" ${senderState.scanning ? "disabled" : ""}>${senderState.scanning ? "Scanning..." : "Pick Folder"}</button>
        <button id="create-session" ${senderState.fileCount === 0 || senderState.scanning ? "disabled" : ""}>Start Server</button>
      </div>

      <div class="meta">${scanningMeta}</div>
      ${senderState.scanning ? `<progress class="scan-progress" max="100" value="100"></progress>` : ""}

      <div id="session-output" class="session-output"></div>
    </div>
  `;
}

function receiveHtml(): string {
  if (receiverState.connected) {
    const files = flattenTree(receiverState.sharedTree);
    return `
      <div class="explorer-page">
        <div id="receiver-progress" class="meta explorer-progress"></div>
        ${
          files.length
            ? renderFileGrid(files)
            : "<p class='muted'>Waiting for sender files...</p>"
        }
      </div>
    `;
  }

  return `
    <div class="stack">
      <h2>Receive Files</h2>
      <label>Session Code <input id="join-code" placeholder="X7K9" /></label>

      <div class="button-row">
        <button id="join-session">Join</button>
      </div>

      <div id="receiver-progress" class="meta"></div>
      <div class="downloads"></div>
    </div>
  `;
}

function bindSendHandlers(): void {
  const pickFolder = document.querySelector<HTMLButtonElement>("#pick-folder");
  const createSession = document.querySelector<HTMLButtonElement>("#create-session");

  if (pickFolder) {
    pickFolder.onclick = async () => {
      try {
        senderState.scanning = true;
        senderState.scanFileCount = 0;
        senderState.scanTotalSize = 0;
        render();

        const scan = await pickFolderTree((progress) => {
          senderState.scanFileCount = progress.fileCount;
          senderState.scanTotalSize = progress.totalSize;
          if (mode === "send") {
            render();
          }
        });
        senderState.tree = scan.tree;
        senderState.flatFiles = scan.flatFiles;
        senderState.totalSize = scan.totalSize;
        senderState.fileCount = scan.fileCount;
        senderState.scanning = false;
        render();
        setStatus(`Folder scanned: ${scan.fileCount} files, ${formatBytes(scan.totalSize)}.`);
      } catch (error) {
        senderState.scanning = false;
        render();
        setStatus(`Folder scan failed: ${(error as Error).message}`);
      }
    };
  }

  if (createSession) {
    createSession.onclick = async () => {
      if (senderState.fileCount === 0) {
        setStatus("Pick a folder first.");
        return;
      }

      try {
        const created = await signaling.createSession({
          name: "Ashare Session",
          file_count: senderState.fileCount,
          total_size: senderState.totalSize,
          network_hint: networkHint
        });

        senderState.sessionId = created.session_id;
        const senderPeerId = `sender-${Math.random().toString(36).slice(2, 10)}`;
        const wsUrl = `${created.ws_url}?role=sender&peer_id=${encodeURIComponent(senderPeerId)}`;
        signaling.connect(wsUrl);

        renderSendSessionOutput(created.session_id, created.expires_in);
        setStatus("Session created. Waiting for receivers.");
      } catch (error) {
        setStatus(`Session creation failed: ${(error as Error).message}`);
      }
    };
  }
}

function bindReceiveHandlers(): void {
  const joinButton = document.querySelector<HTMLButtonElement>("#join-session");
  const requestButtons = document.querySelectorAll<HTMLButtonElement>("button[data-request-file]");

  if (joinButton) {
    joinButton.onclick = () => {
      void joinFromInputs();
    };
  }

  requestButtons.forEach((button) => {
    button.onclick = () => {
      const fileId = button.dataset.requestFile;
      if (!fileId || !receiverState.mesh) {
        return;
      }
      const state = receiverState.sharedFiles.find((item) => item.id === fileId);
      if (!state) {
        return;
      }
      if (state.saved) {
        return;
      }
      const sent = receiverState.mesh.requestFile(fileId);
      if (!sent) {
        setStatus("Unable to request file right now.");
        return;
      }
      state.requested = true;
      render();
      setStatus(`Downloading: ${state.name}`);
    };
  });
}

async function joinFromInputs(): Promise<void> {
  const codeInput = document.querySelector<HTMLInputElement>("#join-code");
  if (!codeInput?.value) {
    setStatus("Enter the share code first.");
    return;
  }

  try {
    receiverState.connected = false;
    receiverState.sharedTree = [];
    receiverState.sharedFiles = [];
    const result = await signaling.joinSession({
      session_id: codeInput.value.trim().toUpperCase(),
      network_hint: networkHint
    });

    receiverState.sessionId = codeInput.value.trim().toUpperCase();
    signaling.connect(result.ws_url);
    setStatus("Connected to signaling.");
  } catch (error) {
    setStatus(`Join failed: ${(error as Error).message}`);
  }
}

async function onSignalMessage(message: SignalMessage): Promise<void> {
  if (message.kind === "hello") {
    if (message.role === "sender") {
      senderState.senderPeerId = message.peer_id;
      senderState.mesh = new WebRtcMesh({
        sessionId: senderState.sessionId ?? message.session_id,
        localPeerId: message.peer_id,
        localRole: "sender",
        outboundSignal: (payload) => signaling.send(payload),
        senderOptions: {
          files: senderState.flatFiles,
          totalSize: senderState.totalSize
        }
      });
      bindMeshEvents(senderState.mesh, true);
      return;
    }

    receiverState.receiverPeerId = message.peer_id;
    receiverState.mesh = new WebRtcMesh({
      sessionId: receiverState.sessionId ?? message.session_id,
      localPeerId: message.peer_id,
      localRole: "receiver",
      outboundSignal: (payload) => signaling.send(payload)
    });
    bindMeshEvents(receiverState.mesh, false);
    receiverState.mesh.onResumeStateRequired = () => collectResumeOffsets(receiverState.sessionId ?? "");
    return;
  }

  if (message.kind === "approval_request") {
    signaling.send({ kind: "approval_response", peer_id: message.peer_id, approved: true });
    void senderState.mesh?.initiateToPeer(message.peer_id);
    return;
  }

  if (message.kind === "approval_response") {
    return;
  }

  if (message.kind === "transfer_intent") {
    const files = flattenTree(message.tree);
    receiverState.sharedTree = message.tree;
    receiverState.sharedFiles = files.map((file) => {
      const existing = receiverState.sharedFiles.find((item) => item.id === file.id);
      return {
        id: file.id,
        name: file.name,
        path: file.path,
        size: file.size,
        mime: file.mime,
        saved: existing?.saved ?? false,
        requested: existing?.requested ?? false,
        url: existing?.url
      };
    });
    if (mode === "receive") {
      render();
    }
    return;
  }

  if (message.kind === "peer_left") {
    senderState.mesh?.closePeer(message.peer_id);
    receiverState.mesh?.closePeer(message.peer_id);
    setStatus(`Peer disconnected: ${message.peer_id}`);
    return;
  }

  await senderState.mesh?.handleSignal(message);
  await receiverState.mesh?.handleSignal(message);
}

function bindMeshEvents(mesh: WebRtcMesh, isSender: boolean): void {
  mesh.onPeerConnected = (peerId) => {
    setStatus(`Peer connected: ${peerId}`);
    if (isSender) {
      signaling.send({
        kind: "transfer_intent",
        to_peer_id: peerId,
        tree: senderState.tree,
        total_size: senderState.totalSize
      });
    } else {
      receiverState.connected = true;
      render();
    }
  };

  mesh.onPeerDisconnected = (peerId) => {
    setStatus(`Peer disconnected: ${peerId}`);
    if (!isSender) {
      receiverState.connected = false;
      render();
    }
  };

  mesh.onTransfer = (peerId, stats) => {
    if (isSender) {
      return;
    }
    const target = document.querySelector<HTMLDivElement>("#receiver-progress");
    if (!target) {
      return;
    }

    const ratio = stats.totalBytes > 0 ? (stats.transferredBytes / stats.totalBytes) * 100 : 0;
    const eta = stats.etaSeconds > 0 ? `${Math.ceil(stats.etaSeconds)}s` : "--";

    target.innerHTML = `
      <div class="progress-card">
        <strong>${peerId}</strong>
        <div>${formatBytes(stats.transferredBytes)} / ${formatBytes(stats.totalBytes)}</div>
        <div>${stats.speedMbps.toFixed(2)} Mbps • ETA ${eta}</div>
        <progress max="100" value="${Math.min(100, ratio)}"></progress>
      </div>
    `;
  };

  mesh.onFileReady = (id, name, blob, path) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);

    const existing = receiverState.sharedFiles.find((item) => item.id === id);
    if (existing) {
      existing.saved = true;
      existing.requested = false;
      existing.mime = blob.type || existing.mime;
    } else {
      receiverState.sharedFiles.unshift({
        id,
        name,
        path,
        size: blob.size,
        mime: blob.type || "application/octet-stream",
        saved: true,
        requested: false
      });
    }
    mode = "receive";
    render();
    setStatus(`Saved: ${name}`);
  };

  mesh.onFileSaved = (id, name) => {
    const existing = receiverState.sharedFiles.find((item) => item.id === id);
    if (existing) {
      existing.saved = true;
      existing.requested = false;
    }
    mode = "receive";
    render();
    setStatus(`Saved: ${name}`);
  };

  mesh.onFileMetadata = (file) => {
    const exists = receiverState.sharedFiles.some((item) => item.id === file.id);
    if (exists) {
      return;
    }
    receiverState.sharedFiles.push({
      id: file.id,
      name: file.name,
      path: file.path,
      size: file.size,
      mime: file.mime,
      saved: false,
      requested: false
    });
    if (!isSender) {
      render();
    }
  };
}

function renderSendSessionOutput(sessionId: string, expiresIn: number): void {
  const target = document.querySelector<HTMLDivElement>("#session-output");
  if (!target) {
    return;
  }

  target.innerHTML = `
    <div class="code">Code: <strong>${sessionId}</strong> (expires in ${expiresIn}s)</div>
    <small>Share this code with receiver.</small>
  `;
}

function collectResumeOffsets(sessionId: string): FileOffset[] {
  const offsets: FileOffset[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(`ashare:recv:${sessionId}:`)) {
      continue;
    }

    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as { file_id: string; chunk_index: number };
      if (parsed.file_id && Number.isFinite(parsed.chunk_index)) {
        offsets.push({ file_id: parsed.file_id, chunk_index: parsed.chunk_index });
      }
    } catch {
      // Ignore malformed resume records.
    }
  }
  return offsets;
}

function renderFileGrid(files: FileNode[]): string {
  return `
    <div class="explorer grid-explorer">
      <div class="explorer-bar">
        <span>Explorer</span>
        <span>${files.length} files</span>
      </div>
      <div class="file-grid">
        ${files
          .map((node) => {
            const state = receiverState.sharedFiles.find((item) => item.id === node.id);
            const isSaved = Boolean(state?.saved);
            const isRequested = Boolean(state?.requested);
            return `
              <article class="file-card">
                <h4>${node.name}</h4>
                <p>${node.path}</p>
                <small>${formatBytes(node.size)}</small>
                <div class="tree-actions">
                  ${
                    isSaved
                      ? `<span class="tree-saved-tag">Saved</span>`
                      : `<button data-request-file="${node.id}" class="tree-download-btn">${isRequested ? "Downloading..." : "Download"}</button>`
                  }
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function setStatus(text: string): void {
  const status = document.querySelector<HTMLDivElement>("#status-bar");
  if (!status) {
    return;
  }
  status.textContent = text;
}
