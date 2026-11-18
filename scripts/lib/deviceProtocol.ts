export interface DeviceRecord {
  value: string | null;
  revision: number;
}

export interface DeviceSnapshot {
  id: string;
  records: Record<string, DeviceRecord>;
}

export interface DeviceChange {
  key: string;
  value: string | null;
  expected: number;
}

export const DEVICE_PREFIX = '/device/';
export const DEVICE_HEADER = 'x-bas-device';
export const DEVICE_TEST_HEADER = 'x-bas-device-test';
/** Identity of the database a window loaded; a mismatch means the data folder changed and the window must reload. */
export const DEVICE_ID_HEADER = 'x-bas-device-id';
export const BINARY_PREFIX = 'bas.binary.';

/** FR-339: `copy` moves current data into an empty folder, `open` uses data already in the folder, `default` is recovery only. */
export type DeviceLocationMode = 'copy' | 'open' | 'default';

export interface DeviceLocation {
  /** Null when the saved pointer cannot be read. */
  path: string | null;
  defaultPath: string;
  isDefault: boolean;
  /** Pinned by BAS_DEVICE_DIR. */
  fixed: boolean;
  available: boolean;
}

export type FolderRootKind = 'current' | 'default' | 'home' | 'documents' | 'drive' | 'system';

export interface DeviceFolderListing {
  path: string;
  parent: string | null;
  folders: string[];
  truncated: boolean;
  roots: { kind: FolderRootKind; path: string }[];
  target: { hasData: boolean; warnings: 'syncedFolder'[]; error?: string };
}

export function isDeviceKey(key: string): boolean {
  return key.length <= 512 && (
    key.startsWith('bas.scope.') || key.startsWith(BINARY_PREFIX) ||
    ['bas.projects', 'bas.settings', 'bas.packs.index', 'bas.ai.settings', 'bas.ai.ledger',
      'bas.ops.brand', 'bas.show.settings', 'bas.uc.readAloud', 'bas.proj.ui'].includes(key)
  );
}
