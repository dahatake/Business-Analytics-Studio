// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { pickNativeFolder, type PickerRunner } from '../scripts/lib/nativeFolderPicker.ts';

const signal = () => new AbortController().signal;
const missing = () => Object.assign(new Error('missing executable'), { code: 'ENOENT' });

describe('OS folder picker', () => {
  it('uses the Windows Forms folder component with separately passed Unicode values and preserves cancellation', async () => {
    const execute = vi.fn<PickerRunner>()
      .mockResolvedValueOnce({ code: 0, stdout: 'C:\\Data\\日本語', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const title = '選択 "quoted" & folder';
    const initial = 'C:\\Data\\日本語';
    expect(await pickNativeFolder(initial, title, signal(), 'win32', execute)).toBe(initial);
    const [, args, options] = execute.mock.calls[0]!;
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('System.Windows.Forms.FolderBrowserDialog');
    expect(script).toContain('$owner.TopMost = $true');
    expect(script).toContain('$dialog.ShowDialog($owner)');
    expect(script).not.toContain(title);
    expect(options.env?.BAS_FOLDER_PROMPT).toBe(title);
    expect(options.env?.BAS_FOLDER_INITIAL).toBe(initial);
    expect(await pickNativeFolder(initial, title, signal(), 'win32', execute)).toBeNull();
  });

  it('uses the macOS folder dialog and keeps spaces in the returned path', async () => {
    const execute = vi.fn<PickerRunner>()
      .mockResolvedValueOnce({ code: 0, stdout: '/tmp/folder with space \n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '\n', stderr: '' });
    expect(await pickNativeFolder('/tmp', 'Choose folder', signal(), 'darwin', execute)).toBe('/tmp/folder with space ');
    expect(execute.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['Choose folder', '/tmp']));
    expect(await pickNativeFolder('/tmp', 'Choose folder', signal(), 'darwin', execute)).toBeNull();
  });

  it('uses Linux desktop dialogs, falls back only when zenity is missing, and distinguishes cancellation from errors', async () => {
    const execute = vi.fn<PickerRunner>()
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce({ code: 0, stdout: '/tmp/chosen\n', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Gtk-Message: 12:00:00.000: GtkDialog mapped without a transient parent. This is discouraged.\n' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Cannot open display' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    expect(await pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute)).toBe('/tmp/chosen');
    expect(execute.mock.calls[0]?.[0]).toBe('zenity');
    expect(execute.mock.calls[1]?.[0]).toBe('kdialog');
    expect(await pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute)).toBeNull();
    expect(await pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute)).toBeNull();
    await expect(pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute))
      .rejects.toMatchObject({ code: 'locationPickerFailed' });
    await expect(pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute))
      .rejects.toMatchObject({ code: 'locationPickerFailed' });
  });

  it('reports when no supported picker is available instead of treating it as cancellation', async () => {
    const execute = vi.fn<PickerRunner>().mockRejectedValue(missing());
    await expect(pickNativeFolder('/tmp', 'Choose folder', signal(), 'linux', execute))
      .rejects.toMatchObject({ code: 'locationPickerUnavailable' });
    await expect(pickNativeFolder('/tmp', 'Choose folder', signal(), 'freebsd', execute))
      .rejects.toMatchObject({ code: 'locationPickerUnavailable' });
  });
});
