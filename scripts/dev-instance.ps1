<#
  تشغيل/فحص/إيقاف نسخة معزولة من التطبيق (بلا قاعدة بيانات الشركة)
  =====================================================================
  • ينسخ الشيفرة إلى مجلد مؤقت خارج المستودع (لا يكتب داخل المشروع)
  • يعمل على منفذ متاح (افتراضي 4313) ببيئة WORKFLOW_TEST_MODE=1 (بلا DB)
  • الأوامر: start | status | stop | ps1-help
  • لا يوقف عملية الإنتاج على 4310 ولا يعدّل إعداداتها
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'status', 'stop', 'help')] [string]$Command = 'status',
  [int]$Port = 4313,
  [string]$InstanceDir = '',
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$repo = Join-Path $repo '..' | Resolve-Path -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $repo 'src/server.js'))) { $repo = (Get-Location).Path }

function Get-InstancePath {
  if ($InstanceDir) { return $InstanceDir }
  return (Join-Path ([System.IO.Path]::GetTempPath()) ("ccs-dev-" + $Port))
}
function Get-Instance { param([string]$dir) Join-Path $dir 'instance.json' }

function Write-State { param($dir, $data) $data | ConvertTo-Json -Depth 5 | Set-Content -Path (Get-Instance $dir) -Encoding UTF8 }
function Read-State { param($dir) $f = Get-Instance $dir; if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { $null } }

switch ($Command) {
  'start' {
    $dir = Get-InstancePath
    $st = Read-State $dir
    if ($st -and (Get-Process -Id $st.pid -ErrorAction SilentlyContinue)) {
      Write-Host ("النسخة تعمل بالفعل (PID {0}) على المنفذ {1} — استخدم stop لإيقافها." -f $st.pid, $st.port)
      exit 0
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
      Write-Host ("المنفذ {0} مشغول — اختر منفذًا آخر (-Port)." -f $Port); exit 3
    }
    if ($Fresh -and (Test-Path $dir)) { Remove-Item $dir -Recurse -Force }
    if (-not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir | Out-Null
      foreach ($d in 'src', 'public', 'python', 'node_modules') {
        $src = Join-Path $repo $d
        if (Test-Path $src) { Copy-Item $src -Destination $dir -Recurse -Force }
      }
      Copy-Item (Join-Path $repo 'package.json') -Destination $dir -Force
    }
    $env:PORT = "$Port"; $env:HOST = '127.0.0.1'; $env:WORKFLOW_TEST_MODE = '1'
    $log = Join-Path $dir 'server.log'
    $p = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory $dir `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
      if ($p.HasExited) { break }
    }
    if (-not $ready) {
      Write-Host 'فشل التشغيل — آخر السجل:'; Get-Content $log -Tail 20 -ErrorAction SilentlyContinue; exit 4
    }
    Write-State $dir @{ pid = $p.Id; port = $Port; dir = $dir; startedAt = (Get-Date).ToString('o'); repo = $repo }
    Write-Host ("النسخة المعزولة تعمل: PID {0} · http://127.0.0.1:{1} · (بلا قاعدة بيانات)" -f $p.Id, $Port)
    exit 0
  }
  'status' {
    $dir = Get-InstancePath
    $st = Read-State $dir
    if (-not $st) { Write-Host 'لا توجد نسخة معزولة مسجَّلة لهذا المنفذ.'; exit 1 }
    $alive = Get-Process -Id $st.pid -ErrorAction SilentlyContinue
    Write-Host ("النسخة: PID {0} · المنفذ {1} · الحالة: {2}" -f $st.pid, $st.port, $(if ($alive) { 'تعمل' } else { 'متوقفة' }))
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/auth/me" -f $st.port) -UseBasicParsing -TimeoutSec 5
      Write-Host ("  فحص المسارات: HTTP {0}" -f $r.StatusCode)
    } catch { Write-Host ("  فحص المسارات: {0}" -f $_.Exception.Message) }
    $prod = Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue
    Write-Host ("  عملية الإنتاج 4310: {0}" -f $(if ($prod) { "PID $($prod.OwningProcess) (لم تُمس)" } else { 'غير مشغّلة' }))
    exit 0
  }
  'stop' {
    $dir = Get-InstancePath
    $st = Read-State $dir
    if (-not $st) { Write-Host 'لا توجد نسخة مسجَّلة.'; exit 1 }
    try { Stop-Process -Id $st.pid -Force -ErrorAction Stop; Write-Host ("أُوقفت النسخة PID {0}" -f $st.pid) } catch { Write-Host ("تعذّر الإيقاف: {0}" -f $_.Exception.Message) }
    Start-Sleep -Milliseconds 800
    if (Get-NetTCPConnection -LocalPort $st.port -State Listen -ErrorAction SilentlyContinue) { Write-Host 'المنفذ ما زال مشغولًا'; exit 5 }
    Write-Host 'المنفذ تحرّر.'
    exit 0
  }
  'help' {
    Write-Host @'
الاستخدام:
  pwsh -File scripts/dev-instance.ps1 start  [-Port 4313] [-Fresh]   # تشغيل نسخة معزولة (بلا DB)
  pwsh -File scripts/dev-instance.ps1 status [-Port 4313]             # فحص الحالة + عملية الإنتاج
  pwsh -File scripts/dev-instance.ps1 stop   [-Port 4313]             # إيقاف النسخة فقط
ملاحظات:
  • النسخة تعمل في مجلد مؤقت خارج المستودع، وبـ WORKFLOW_TEST_MODE=1 (لا تتصل بقاعدة البيانات).
  • لا يوقف هذا السكربت عملية الإنتاج على 4310 ولا يعدّل بياناتها.
  • النسخة تُبنى من نسخة الشيفرة وقت التشغيل ⇒ بعد أي تعديل استخدم start -Fresh لتحديثها.
'@
    exit 0
  }
}
