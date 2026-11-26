import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocationError } from './deviceLocation.ts';

const execFileAsync = promisify(execFile);

export interface PickerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type PickerRunner = (
  file: string, args: string[], options: { signal: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<PickerResult>;

const run: PickerRunner = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, args, { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
    return { ...result, code: 0 };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') {
      return {
        code: error.code,
        stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
        stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
      };
    }
    throw error;
  }
};

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$owner = New-Object System.Windows.Forms.Form
try {
  $owner.TopMost = $true
  $dialog.Description = $env:BAS_FOLDER_PROMPT
  $dialog.SelectedPath = $env:BAS_FOLDER_INITIAL
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

const MAC_SCRIPT = `
on run argv
  try
    set chosen to choose folder with prompt (item 1 of argv) default location ((POSIX file (item 2 of argv)) as alias)
    return POSIX path of chosen
  on error messageText number errorNumber
    if errorNumber is -128 then return ""
    error messageText number errorNumber
  end try
end run
`;

function missingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function linuxCancellation(result: PickerResult): boolean {
  if (result.code !== 1 || result.stdout) return false;
  // GTK may emit this harmless notice even when the user cancels the dialog.
  return result.stderr.split(/\r?\n/).every((line) => !line.trim() ||
    /^(?:\([^)]*\):\s*)?Gtk-Message:.*GtkDialog mapped without a transient parent\. This is discouraged\.$/.test(line.trim()));
}

/** Opens the OS folder picker on the PC running the local server. */
export async function pickNativeFolder(
  initial: string,
  title: string,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  execute: PickerRunner = run,
): Promise<string | null> {
  try {
    let result: PickerResult;
    if (platform === 'win32') {
      const powershell = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const script = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script], {
        signal, env: { ...process.env, BAS_FOLDER_PROMPT: title, BAS_FOLDER_INITIAL: initial },
      });
    } else if (platform === 'darwin') {
      result = await execute('/usr/bin/osascript', ['-e', MAC_SCRIPT, title, initial], { signal });
    } else if (platform === 'linux') {
      try {
        result = await execute('zenity', [
          '--file-selection', '--directory', `--title=${title}`, `--filename=${initial.replace(/\/?$/, '/')}`,
        ], { signal });
      } catch (error) {
        if (!missingExecutable(error)) throw error;
        result = await execute('kdialog', ['--getexistingdirectory', initial, '--title', title], { signal });
      }
      if (linuxCancellation(result)) return null;
    } else {
      throw new LocationError('locationPickerUnavailable');
    }
    if (result.code !== 0) throw new LocationError('locationPickerFailed');
    const path = result.stdout.replace(/\r?\n$/, '');
    if (!path && platform === 'linux') throw new LocationError('locationPickerFailed');
    return path || null;
  } catch (error) {
    if (signal.aborted || error instanceof LocationError) throw error;
    throw new LocationError(missingExecutable(error) ? 'locationPickerUnavailable' : 'locationPickerFailed');
  }
}
