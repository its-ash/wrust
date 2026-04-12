import { hashBytes } from "./wasm";
import type { FileNode } from "./types";

export type FileScanResult = {
  tree: FileNode[];
  fileCount: number;
  totalSize: number;
  flatFiles: FileNode[];
};

type ScanProgress = {
  fileCount: number;
  totalSize: number;
};

export async function pickFolderTree(onProgress?: (progress: ScanProgress) => void): Promise<FileScanResult> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;

  if (!picker) {
    throw new Error("File System Access API is unavailable. Use drag & drop fallback.");
  }

  const root = await picker();
  const tree: FileNode[] = [];
  const flatFiles: FileNode[] = [];
  let totalSize = 0;
  let fileCount = 0;

  for await (const entry of root.values()) {
    const node = await walkEntry(entry, root.name, (fileSize) => {
      fileCount += 1;
      totalSize += fileSize;
      onProgress?.({ fileCount, totalSize });
    });
    tree.push(node.node);
    flatFiles.push(...node.files);
  }

  return {
    tree,
    fileCount,
    totalSize,
    flatFiles
  };
}

export async function pickFilesTree(onProgress?: (progress: ScanProgress) => void): Promise<FileScanResult> {
  const selected = await pickFilesFromInput();
  const tree: FileNode[] = [];
  const flatFiles: FileNode[] = [];
  let totalSize = 0;
  let fileCount = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const file = selected[index];
    const relativePath = getFilePath(file);
    const path = relativePath || `Selected Files/${file.name}`;
    const id = `file:${path}:${file.size}:${file.lastModified}:${index}`;
    const hash = await smallHash(file);
    fileCount += 1;
    totalSize += file.size;
    onProgress?.({ fileCount, totalSize });

    const node: FileNode = {
      id,
      name: file.name,
      path,
      mime: file.type || "application/octet-stream",
      size: file.size,
      hash,
      children: [],
      is_dir: false,
      file
    };
    tree.push(node);
    flatFiles.push(node);
  }

  return {
    tree,
    fileCount,
    totalSize,
    flatFiles
  };
}

async function walkEntry(
  entry: FileSystemHandle,
  parentPath: string,
  onFileFound: (fileSize: number) => void
): Promise<{ node: FileNode; files: FileNode[]; totalSize: number }> {
  if (entry.kind === "directory") {
    const dir = entry as FileSystemDirectoryHandle;
    const children: FileNode[] = [];
    const files: FileNode[] = [];
    let totalSize = 0;

    for await (const child of dir.values()) {
      const built = await walkEntry(child, `${parentPath}/${dir.name}`, onFileFound);
      children.push(built.node);
      files.push(...built.files);
      totalSize += built.totalSize;
    }

    return {
      node: {
        id: `dir:${parentPath}/${dir.name}`,
        name: dir.name,
        path: `${parentPath}/${dir.name}`,
        mime: "directory",
        size: totalSize,
        children,
        is_dir: true
      },
      files,
      totalSize
    };
  }

  const fileHandle = entry as FileSystemFileHandle;
  const file = await fileHandle.getFile();
  const id = `file:${parentPath}/${file.name}`;
  const hash = await smallHash(file);
  onFileFound(file.size);

  const node: FileNode = {
    id,
    name: file.name,
    path: `${parentPath}/${file.name}`,
    mime: file.type || "application/octet-stream",
    size: file.size,
    hash,
    children: [],
    is_dir: false,
    file
  };

  return {
    node,
    files: [node],
    totalSize: file.size
  };
}

async function smallHash(file: File): Promise<string> {
  const sample = file.slice(0, Math.min(file.size, 64 * 1024));
  const buffer = await sample.arrayBuffer();
  return hashBytes(new Uint8Array(buffer));
}

function getFilePath(file: File): string {
  const withRelative = file as File & { webkitRelativePath?: string };
  if (withRelative.webkitRelativePath && withRelative.webkitRelativePath.length > 0) {
    return withRelative.webkitRelativePath;
  }
  return file.name;
}

async function pickFilesFromInput(): Promise<File[]> {
  return await new Promise<File[]>((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;
    input.type = "file";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "-9999px";

    const cleanup = (): void => {
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
    };

    const finalize = (result: File[] | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    };

    const onWindowFocus = (): void => {
      window.setTimeout(() => {
        if (!settled) {
          finalize(new Error("No files selected."));
        }
      }, 0);
    };

    input.addEventListener("change", () => {
      const picked = Array.from(input.files ?? []);
      if (picked.length === 0) {
        finalize(new Error("No files selected."));
        return;
      }
      finalize(picked);
    });

    input.addEventListener("cancel", () => {
      finalize(new Error("File selection cancelled."));
    });

    window.addEventListener("focus", onWindowFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export function flattenTree(tree: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const node of tree) {
    if (node.is_dir) {
      out.push(...flattenTree(node.children));
    } else {
      out.push(node);
    }
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}
