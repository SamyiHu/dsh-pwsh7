# dsh-pwsh7 — PowerShell 7 for the pwsh tool

`dsh-pwsh7` pins the DSH shell executor (the `pwsh` tool) to PowerShell 7 and
refuses to fall back to the Windows PowerShell 5.1 that ships with Windows.

## What it does

On activation it resolves a PowerShell 7 executable, and pins the live shell
executor to it:

1. `config.path` — the row's `path` value in `cordis.patch.yml`
2. `DSH_PWSH7_PATH` environment variable
3. `%ProgramFiles%\PowerShell\7\pwsh.exe`
4. `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe`
5. `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` (Microsoft Store / MSIX)
6. every `PATH` entry, `<entry>\pwsh.exe`

Each candidate is not trusted by existence alone: the plugin runs it and reads
`$PSVersionTable.PSVersion`, and only accepts major version 7 or newer. The
chosen folder is also moved to the front of `PATH`, so child processes and any
component that resolves `pwsh` through `PATH` (including the terminal backend
when it is mounted) see the same executable.

When no PowerShell 7 is found, the plugin fails loudly: shell commands raise
`dsh-pwsh7: PowerShell 7 is required ...` instead of silently running 5.1.

## Install

```powershell
git clone https://github.com/SamyiHu/dsh-pwsh7.git
```

Then install that directory as a bundle: **Settings → Plugins → Add plugin** (a
local directory), or `plugin_manager` `install_bundle` with the absolute path.

Install PowerShell 7 first:

```powershell
winget install --id Microsoft.PowerShell -e
```

Restart DeepSeek Harness afterwards so the plugin re-resolves at boot.

## Configuration

```yaml
- id: pwsh7
  name: dsh-pwsh7
  config:
    path: ''       # explicit pwsh.exe; empty = auto-detect
    strict: true   # false = warn instead of blocking the shell when PS7 is missing
```

## Status file

Every boot writes `status.json` beside this file:

```json
{
  "ok": true,
  "resolvedPath": "C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
  "version": "7.7.0",
  "effectivePath": "C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"
}
```

`effectivePath` is read back from the live shell executor, so `ok: false` means
the pin did not reach the executor (a restart is then required).

## Limits

- Windows only; the row is disabled on other platforms.
- The bundle patch replaces the `pwsh-sandbox` row's whole `config`; it only
  writes `pwshPath`, which is the only field that row carries here.
- It pins the agent `pwsh` tool and `PATH` resolution. The integrated-terminal
  backend (`terminal-bash`) is not mounted in this profile; if it is mounted
  later, a backend that already resolved its own `shellPath` keeps that path
  until the next restart.
- Turning the plugin off restores DSH's built-in resolution.
