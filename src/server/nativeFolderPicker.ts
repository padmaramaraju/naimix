import { spawn } from "node:child_process";

/**
 * Opens a native OS folder-picker dialog and resolves to the chosen
 * absolute path, or `null` if the user cancelled/closed it.
 *
 * This does NOT go through the `dialog-node` package the admin UI's
 * "Browse..." button was originally built against. `dialog-node`'s only
 * relevant primitive is `fileselect()`, which wraps AppleScript's
 * `choose file` on macOS and `zenity --file-selection` on Linux -- both
 * pick a FILE, not a folder, and neither exposes a directory-picking mode
 * (confirmed by reading dialog-node's own source: there is no
 * `folderselect`/`--directory` anywhere in it). Depending on it here would
 * mean either shipping a "folder picker" that's secretly a file picker, or
 * bolting on a `path.dirname(selectedFile)` workaround that breaks the
 * moment someone picks (or needs to create) an empty folder.
 *
 * Instead this reimplements just the folder-selection case using the exact
 * same technique dialog-node itself uses -- shelling out to each OS's own
 * built-in dialog tool -- just with the argument that actually asks for a
 * directory: AppleScript's `choose folder` (macOS), `zenity
 * --file-selection --directory` (Linux), and .NET's FolderBrowserDialog via
 * PowerShell (Windows, which has no zenity/AppleScript equivalent and whose
 * VBScript msgbox.vbs -- what dialog-node itself shells out to -- has no
 * folder-picking mode either). No new dependency, and no heavier
 * cross-platform UI toolkit (Electron, Qt) required for one dialog.
 */
export async function pickFolderNative(startDir: string): Promise<string | null> {
  switch (process.platform) {
    case "darwin": {
      const script = `POSIX path of (choose folder with prompt "Select the naimix workspace folder" default location (POSIX file "${escapeForAppleScript(startDir)}"))`;
      return runPicker("osascript", ["-e", script]);
    }
    case "linux": {
      const startWithSlash = startDir.endsWith("/") ? startDir : `${startDir}/`;
      return runPicker("zenity", [
        "--file-selection",
        "--directory",
        "--title=Select the naimix workspace folder",
        `--filename=${startWithSlash}`,
      ]);
    }
    case "win32": {
      const psScript = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.SelectedPath = "${escapeForPowerShell(startDir)}"`,
        '$dialog.Description = "Select the naimix workspace folder"',
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
      ].join("\n");
      return runPicker("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
    }
    default:
      throw new Error(`No native folder picker is available on this OS ("${process.platform}").`);
  }
}

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeForPowerShell(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '""');
}

/** Runs one of the OS dialog tools and resolves to its selected path, or
 * `null` for a cancel/close -- osascript, zenity, and PowerShell all exit
 * non-zero (or print nothing) when the user cancels, which is a normal
 * outcome here, not a failure. Only "the tool itself couldn't run" (e.g.
 * zenity not installed on a minimal Linux desktop) rejects. */
function runPicker(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`"${bin}" isn't available on this machine, so the folder picker can't be shown. Type the path instead.`));
        return;
      }
      reject(new Error(`Couldn't launch the folder picker (${bin}): ${err.message}`));
    });

    child.on("exit", (code) => {
      const picked = stdout.trim();
      if (code === 0 && picked) {
        resolve(picked);
        return;
      }
      if (code !== 0 && stderr && !/user (canceled|cancelled)/i.test(stderr)) {
        // A real tool error (not a plain cancel) -- surface it rather than
        // silently treating it as "user closed the dialog".
        reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`));
        return;
      }
      resolve(null);
    });
  });
}
