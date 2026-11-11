import fs from 'node:fs';

/** Windows file scanners can briefly hold the destination without FILE_SHARE_DELETE. Never remove the old file. */
export function replaceFileSync(source: string, destination: string) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
      Atomics.wait(wait, 0, 0, 10 * 2 ** attempt);
    }
  }
}
