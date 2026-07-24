// Shared types for the Android Control Panel backend.

export interface BatteryInfo {
  level: number | null;
  charging: boolean | null;
  status?: string | null;
  temperature?: number | null;
}

export interface StorageInfo {
  path: string;
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
}

export interface RamInfo {
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
}

export interface CpuInfo {
  model: string;
  cores: number;
}

export interface BridgeStatus {
  termuxBridge: boolean;
  adb: boolean;
  shizuku: boolean;
}

export interface DeviceInfo {
  model: string;
  manufacturer: string;
  androidVersion: string;
  sdk: string;
  battery: BatteryInfo;
  storage: StorageInfo;
  ram: RamInfo;
  cpu: CpuInfo;
  ip: string;
  bridges: BridgeStatus;
}

export interface AndroidApp {
  name: string;
  packageName: string;
  system: boolean;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  transport?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface InstallResult {
  ok: boolean;
  method: string;
  detail: string;
}
