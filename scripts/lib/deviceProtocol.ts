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
export const BINARY_PREFIX = 'bas.binary.';

export function isDeviceKey(key: string): boolean {
  return key.length <= 512 && (
    key.startsWith('bas.scope.') || key.startsWith(BINARY_PREFIX) ||
    ['bas.projects', 'bas.settings', 'bas.packs.index', 'bas.ai.settings', 'bas.ai.ledger',
      'bas.ops.brand', 'bas.show.settings', 'bas.uc.readAloud', 'bas.proj.ui'].includes(key)
  );
}
