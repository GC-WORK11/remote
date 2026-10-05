# remote install (Windows) -- build-free installer for a prebuilt omprd.exe.
#
# What it does, honestly:
#   * copies omprd.exe to %LOCALAPPDATA%\omprd\ (or uses -Bin path as-is)
#   * registers a per-user Task Scheduler job that starts omprd at LOGON
#     through a wscript wrapper -- the only zero-dep way to keep a console
#     binary fully windowless in an INTERACTIVE session (needed for
#     computer-use; "Run whether user is logged on or not" would land the
#     daemon in session 0 where it cannot drive the desktop)
#   * sets the active power scheme's lid action to "do nothing" (AC+DC)
#     when run elevated and the machine actually HAS a lid
#
# What it refuses to pretend:
#   * no admin shell  -> lid policy commands are printed, not run
#   * no LIDACTION in the scheme (VMs, desktops, most servers) -> reported
#     as no-lid, not "success"; a write there returns 0 but changes nothing
#   * Modern Standby (S0) laptops may still drop Wi-Fi on lid close --
#     omprd keeps running but the link can die; WoWLAN-capable NICs are the
#     exception. Detected below and printed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File install-windows.ps1
#         optional: -Bin C:\path\omprd.exe -OmpBin C:\path\omp.cmd -Port 8790
#                   -Bind ""   (empty -> bind the LAN IP, the default on other OSes;
#                               loopback is the shipped default since pairing the
#                               QR advertises the LAN IP the daemon must actually
#                               listen on -- same-Wi-Fi pairing cannot work bound
#                               to 127.0.0.1)
# Rerun any time; it is idempotent.
param(
    [string]$Bin = "",
    [string]$OmpBin = "",
    [int]$Port = 8790,
    [string]$Bind = "127.0.0.1",
    [string]$TaskName = "Remote\omprd"
)
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "install: $m" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# --- locate omprd.exe --------------------------------------------------------
if (-not $Bin) {
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    foreach ($c in @("$here\daemon\omprd.exe", "$here\omprd.exe",
                     "$env:LOCALAPPDATA\omprd\omprd.exe")) {
        if (Test-Path $c) { $Bin = (Resolve-Path $c).Path; break }
    }
}
if (-not $Bin -or -not (Test-Path $Bin)) {
    throw "omprd.exe not found -- build it first (g++ -O2 -std=c++20 -static -o daemon/omprd.exe daemon/omprd.cpp -lws2_32) or pass -Bin"
}

# --- locate omp ---------------------------------------------------------------
if (-not $OmpBin) {
    $cmd = Get-Command omp, omp.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $OmpBin = $cmd.Source }
}
$ompArg = if ($OmpBin) { " --omp-bin `"$OmpBin`"" } else {
    Say "omp not on PATH -- omprd will run but session.new needs --omp-bin later"
    ""
}

# --- install dir + hidden launcher -------------------------------------------
$dstDir = "$env:LOCALAPPDATA\omprd"
New-Item -ItemType Directory -Force -Path $dstDir, "$env:USERPROFILE\.rig" | Out-Null
if ((Resolve-Path $Bin).Path -ne "$dstDir\omprd.exe") {
    Copy-Item -Force $Bin "$dstDir\omprd.exe"
}
$exe = "$dstDir\omprd.exe"
Say "binary: $exe"

# wscript launches omprd via cmd so output still lands in omprd.log while the
# console window never appears. (PowerShell -WindowStyle Hidden flashes a
# console; a session-0 task can't drive the desktop. VBS Run(,0,) is the
# smallest honest windowless launcher.) cmd /c strips its outer quote pair, so
# the exe path is quoted INSIDE, args outside, and the whole line re-quoted.
$vbs = "$dstDir\omprd-run.vbs"
# Empty -Bind omits the flag so omprd auto-detects (tailscale -> LAN -> loopback),
# which is what the pairing QR advertises; the shipped default keeps loopback.
$bindArg = if ($Bind) { " --bind `"$Bind`"" } else { "" }
$daemonArgs = "`"$exe`" --port $Port$bindArg --keep-awake$ompArg"
$cmdLine = "cmd.exe /d /c `"$daemonArgs >> `"%USERPROFILE%\.rig\omprd.log`" 2>&1`""
$vbsCmd = $cmdLine -replace '"', '""'
Set-Content -Encoding ASCII -Path $vbs -Value @"
' launches omprd with no console window; log -> %USERPROFILE%\.rig\omprd.log
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "$vbsCmd", 0, False
"@
Say "launcher: $vbs"

# --- logon task ---------------------------------------------------------------
# /sc onlogon fires per-user in the interactive session -- screens stay real.
schtasks /create /f /sc onlogon /rl limited /tn $TaskName /tr "wscript.exe `"$vbs`"" | Out-Null
Say "task: $TaskName (logon, limited, hidden)"

# --- lid-close policy ---------------------------------------------------------
$lidSetting = (powercfg -q SCHEME_CURRENT SUB_BUTTONS LIDACTION 2>$null |
               Select-String "AC Power Setting Index")
if (-not $lidSetting) {
    Say "lid:  no LIDACTION setting in the active power scheme -- this machine"
    Say "      has no lid hardware (VM/desktop/server). Nothing to neutralize."
} elseif (-not $isAdmin) {
    Say "lid:  LIDACTION present but this shell is NOT elevated -- run this:"
    Say "      powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0"
    Say "      powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0"
    Say "      powercfg -setactive SCHEME_CURRENT"
    Say "      (or send rig.stayAwake {on:true, persistent:true} from the app --"
    Say "       omprd attempts the same writes and reports needs-admin if denied)"
} else {
    powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
    powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
    powercfg -setactive SCHEME_CURRENT | Out-Null
    # powercfg exit codes lie on absent settings -- verify by re-query.
    $q = powercfg -q SCHEME_CURRENT SUB_BUTTONS LIDACTION
    $ac = ([regex]"AC Power Setting Index:\s*0x([0-9a-fA-F]+)").Match($q)
    $dc = ([regex]"DC Power Setting Index:\s*0x([0-9a-fA-F]+)").Match($q)
    $acOk = $ac.Success -and ([Convert]::ToInt64($ac.Groups[1].Value, 16) -eq 0)
    $dcOk = $dc.Success -and ([Convert]::ToInt64($dc.Groups[1].Value, 16) -eq 0)
    if ($acOk -and $dcOk) {
        Say "lid:  LIDACTION AC+DC = do-nothing, verified by re-query"
        Say "      undo: rig.stayAwake {on:false} or powercfg -setacvalueindex ... LIDACTION 1"
    } else {
        Say "lid:  writes ran elevated but re-query does not read 0/0 --"
        Say "      enterprise power policy or MDM may be overriding LIDACTION"
    }
}

# --- Modern Standby / Wi-Fi honesty ------------------------------------------
# powercfg -a prints its "not available" reasons to stderr on lidless boxes --
# under ErrorActionPreference=Stop that would kill the script, so scope it.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$avail = powercfg -a 2>$null | Out-String
$ErrorActionPreference = $prevEAP
# "powercfg -a" names every state it knows in BOTH sections -- only text above
# the "not available" divider describes what this machine can actually do.
$availTxt = ($avail -split "not available")[0]
if ($availTxt -match "S0 Low Power Idle") {
    Say "standby: this machine supports Modern Standby (S0) -- lid close keeps"
    Say "         omprd alive but Wi-Fi may still sleep unless the NIC supports"
    Say "         WoWLAN. Check: Device Manager > NIC > Power Management, and"
    Say "         'powercfg -devicequery wake_armed' for wake-capable devices."
} elseif ($availTxt -match "Standby \(S3\)") {
    Say "standby: classic S3 -- with LIDACTION=0 the lid switch no longer sleeps"
    Say "         the box; AC vs battery profiles honored separately."
} else {
    Say "standby: no S0/S3 sleep states reported (server/VM) -- lid policy is moot."
}
if (Get-Service WlanSvc -ErrorAction SilentlyContinue) {
    Say "wifi:   WlanSvc present -- if the link drops on lid close, disable power"
    Say "        saving on the adapter: Device Manager > adapter > Power Mgmt"
    Say "        ('Allow the computer to turn off this device'), or:"
    Say "        powercfg -attributes SUB_NONE -ATTRIB_HIDE  (advanced view)"
}

# --- start now + verify -------------------------------------------------------
$already = Get-Process omprd -ErrorAction SilentlyContinue
if (-not $already) {
    schtasks /run /tn $TaskName | Out-Null
    Start-Sleep -Seconds 2
}
# probe the address the daemon actually bound: explicit -Bind, else its
# auto-detected LAN IP (loopback probe would report a false negative)
$probeHost = $Bind
if (-not $probeHost -or $probeHost -eq "0.0.0.0") {
    $probeHost = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -First 1).IPAddress
    if (-not $probeHost) { $probeHost = "127.0.0.1" }
}
$listen = Test-NetConnection -ComputerName $probeHost -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
if ($listen) {
    Say "running: omprd listening on ${probeHost}:$Port"
} else {
    Say "NOT listening yet -- check %USERPROFILE%\.rig\omprd.log or run:"
    Say "  $daemonArgs"
}
Say ""
if ($Bind -eq "127.0.0.1") {
    Say "pair the phone:   $exe pair    (prints the QR/URI; rig is bound to 127.0.0.1 --"
    Say "                  same-Wi-Fi pairing cannot connect. For LAN pairing rerun"
    Say "                  with -Bind \"\" and allow omprd.exe in Windows Firewall,"
    Say "                  or expose via Tailscale / ssh -L)"
} else {
    Say "pair the phone:   $exe pair    (QR/URI advertises the LAN IP omprd bound --"
    Say "                  allow omprd.exe inbound on port $Port in Windows Firewall)"
}
Say "verify awake:     rig.status keepawake -> {held, method, needsAdmin, lidOverride}"
