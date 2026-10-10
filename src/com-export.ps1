param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [string]$Password = "",
  [string]$SheetFilter = "",
  [int]$MaxRows = 0,
  [switch]$NoCopy
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

function CellToString($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [double] -or $v -is [decimal] -or $v -is [int16] -or $v -is [int32] -or $v -is [int64] -or $v -is [single]) {
    return ([double]$v).ToString('R', $inv)
  }
  if ($v -is [bool]) { if ($v) { return 'TRUE' } else { return 'FALSE' } }
  return ([string]$v)
}

function Esc($s) {
  if ($s -eq $null) { return '' }
  if ($s -match '[",\r\n]') { return '"' + ($s -replace '"','""') + '"' }
  return $s
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 1) محاولة الالتقاط بنسخة Excel المفتوحة
$excel = $null
$wb = $null
try {
  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
  foreach ($w in $excel.Workbooks) {
    if ($w.FullName -eq $FilePath) { $wb = $w; break }
  }
} catch { $excel = $null }

$createdApp = $false
if (-not $wb) {
  if ($null -eq $excel) {
    $excel = New-Object -ComObject Excel.Application
    $createdApp = $true
  }
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  try {
    if ($Password -ne "") { $wb = $excel.Workbooks.Open($FilePath, 0, $true, [Type]::Missing, $Password) }
    else { $wb = $excel.Workbooks.Open($FilePath, 0, $true) }
  } catch {
    if ($createdApp) { try { $excel.Quit() } catch {} }
    throw "تعذّر فتح الملف في Excel (يحتاج كلمة مرور أو الملف مقفل): $($_.Exception.Message)"
  }
}

# مسار سريع: بناء نسخة جديدة بقيم فقط داخل Excel ثم حفظها (غير محمية بالتأكيد)
# أسرر بكثير من تصدير الشيتات سطراً سطراً، ولا تمسّ الملف الأصلي
if (-not $NoCopy -and $SheetFilter -eq "" -and $MaxRows -le 0) {
  $copyPath = Join-Path $OutDir 'workbook_copy.xlsx'
  $newWb = $null
  try {
    $prevAlerts = $excel.DisplayAlerts
    $excel.DisplayAlerts = $false
    $newWb = $excel.Workbooks.Add()
    while ($newWb.Worksheets.Count -gt 1) { $newWb.Worksheets.Item($newWb.Worksheets.Count).Delete() }
    $idx = 0
    foreach ($ws in $wb.Worksheets) {
      $ur = $ws.UsedRange
      if ($null -eq $ur) { continue }
      $rows = $ur.Rows.Count; $cols = $ur.Columns.Count
      if ($rows -le 0 -or $cols -le 0) { continue }
      if ($idx -eq 0) { $t = $newWb.Worksheets.Item(1) }
      else { $t = $newWb.Worksheets.Add([Type]::Missing, $newWb.Worksheets.Item($newWb.Worksheets.Count)) }
      $idx++
      try { $t.Name = $ws.Name } catch { $t.Name = ('S' + $idx) }
      $t.Cells.Item(1, 1).Resize($rows, $cols).Value2 = $ur.Value2
    }
    $newWb.SaveCopyAs($copyPath)
    $newWb.Close($false)
    $excel.DisplayAlerts = $prevAlerts
    if (Test-Path $copyPath) {
      $jsonCopy = ,([pscustomobject]@{ mode = 'copy'; copy = $copyPath })
      [System.IO.File]::WriteAllText((Join-Path $OutDir 'manifest.json'), (ConvertTo-Json -InputObject $jsonCopy -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
      Write-Output "OK copy"
      return
    }
  } catch {
    try { if ($newWb) { $newWb.Close($false) } } catch {}
    try { $excel.DisplayAlerts = $true } catch {}
    # تجاهل والمُواصلة بمسار CSV
  }
}

$manifest = @()
foreach ($ws in $wb.Worksheets) {
  if ($SheetFilter -ne "" -and $ws.Name -ne $SheetFilter) { continue }
  $ur = $ws.UsedRange
  if ($null -eq $ur) { continue }
  $rows = $ur.Rows.Count
  $cols = $ur.Columns.Count
  if ($rows -le 0 -or $cols -le 0) { continue }
  if ($MaxRows -gt 0 -and $rows -gt $MaxRows) { $rows = $MaxRows }

  $safe = ($ws.Name -replace '[\\/:*?"<>|]', '_')
  $csv = Join-Path $OutDir ($safe + '.csv')
  $sb = New-Object System.Text.StringBuilder
  $blockRows = 20000
  for ($start = 1; $start -le $rows; $start += $blockRows) {
    $n = [Math]::Min($blockRows, $rows - $start + 1)
    $block = $ur.Range($ur.Cells.Item($start, 1), $ur.Cells.Item($start + $n - 1, $cols)).Value2
    for ($i = 1; $i -le $n; $i++) {
      $line = New-Object System.Text.StringBuilder
      for ($j = 1; $j -le $cols; $j++) {
        if ($j -gt 1) { [void]$line.Append(',') }
        $v = if ($block -is [array]) { $block[$i, $j] } else { $block }
        [void]$line.Append((Esc (CellToString $v)))
      }
      [void]$sb.AppendLine($line.ToString())
    }
  }
  $enc = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($csv, $sb.ToString(), $enc)
  $manifest += [pscustomobject]@{ name = $ws.Name; csv = $csv; rows = $rows; cols = $cols }
}

if ($createdApp) {
  try { $wb.Close($false) } catch {}
  try { $excel.Quit() } catch {}
}

$json = ConvertTo-Json -InputObject $manifest -Depth 4
[System.IO.File]::WriteAllText((Join-Path $OutDir 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "OK sheets=$($manifest.Count)"
