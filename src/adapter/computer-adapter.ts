export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  type: FileEntryType;
  size?: number;
  modifiedAt?: string;
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  architecture: string;
  release: string;
  uptimeSeconds: number;
  cwd: string;
}

export interface ExecRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessInfo {
  pid: number;
  parentPid?: number;
  user?: string;
  command: string;
  args?: readonly string[];
}

export interface ComputerAdapter {
  systemInfo(): Promise<SystemInfo>;
  listDirectory(path: string): Promise<readonly FileEntry[]>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  writeFile(path: string, content: string, mode: 'create' | 'overwrite' | 'append'): Promise<void>;
  makeDirectory(path: string, recursive: boolean): Promise<void>;
  movePath(source: string, destination: string): Promise<void>;
  deletePath(path: string, recursive: boolean): Promise<void>;
  exec(request: ExecRequest): Promise<ExecResult>;
  listProcesses(): Promise<readonly ProcessInfo[]>;
  killProcess(pid: number, signal?: NodeJS.Signals): Promise<void>;
}
