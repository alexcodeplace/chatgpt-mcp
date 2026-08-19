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

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ServiceStatus {
  name: string;
  activeState: string;
  subState: string;
  description: string;
}

export interface ApplicationLaunchResult {
  handle: string;
  pid: number;
}

export interface ScreenCapture {
  mimeType: 'image/png';
  data: string;
  bytes: number;
}

export type PointerButton = 'left' | 'middle' | 'right';

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
  serviceStatus(name: string): Promise<ServiceStatus>;
  serviceControl(name: string, action: ServiceAction): Promise<void>;
  launchApplication(name: string, args?: readonly string[]): Promise<ApplicationLaunchResult>;
  closeApplication(handle: string): Promise<void>;
  openBrowser(url: string): Promise<void>;
  captureScreen(): Promise<ScreenCapture>;
  movePointer(x: number, y: number): Promise<void>;
  clickPointer(button: PointerButton, x?: number, y?: number): Promise<void>;
  typeText(text: string, delayMs?: number): Promise<void>;
  pressKey(key: string): Promise<void>;
}
