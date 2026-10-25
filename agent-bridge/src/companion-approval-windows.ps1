$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadLine() | ConvertFrom-Json
    $origin = [string]$request.origin
    $timeoutMs = [int]$request.timeoutMs
    if ($origin.Length -gt 256 -or $origin -match '[\s*]' -or $timeoutMs -lt 1 -or $timeoutMs -gt 90000) { exit 1 }
    $uri = [Uri]$origin
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.GetLeftPart([UriPartial]::Authority) -cne $origin) { exit 1 }
    if (-not [Environment]::UserInteractive) { exit 1 }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TunaCADApprovalWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command); }'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'TunaCAD Companion'
    $form.ClientSize = New-Object System.Drawing.Size(540, 270)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $message = New-Object System.Windows.Forms.Label
    $message.Location = New-Object System.Drawing.Point(20, 20)
    $message.Size = New-Object System.Drawing.Size(500, 180)
    $message.Text = "TunaCAD wants to connect to this computer.`r`n`r`nOrigin:`r`n$origin`r`n`r`nAllows temporary AI workspace sessions only. CAD changes, geometry transfer, simulation, and provider actions still require their separate approvals."
    if ($request.purpose -eq 'simulation') {
        $r = $request.review
        if ($r.schema -cne 'tunacad-trusted-simulation-consent/1' -or $r.origin -cne $origin -or $r.maximumJobs -lt 1 -or $r.maximumJobs -gt 10000 -or $r.maximumMeshes -gt 10000 -or $r.maximumSolverProcesses -gt 20000 -or $r.clients.Count -lt 1 -or $r.clients.Count -gt 32 -or $r.capabilities.Count -lt 1 -or $r.capabilities.Count -gt 32) { exit 1 }
        $form.ClientSize = New-Object System.Drawing.Size(640, 420)
        $message.Size = New-Object System.Drawing.Size(600, 330)
        $message.Text = "Authorize a bounded simulation session?`r`n`r`nOrigin: $origin`r`nWorkspace: $($r.workspaceId)`r`nClients: $($r.clients -join ', ')`r`nCapabilities: $($r.capabilities -join ', ')`r`n`r`nUntil ended or revoked; up to $($r.maximumJobs) jobs, $($r.maximumMeshes) meshes, $($r.maximumSolverProcesses) solver processes.`r`nNodes/elements per job: $($r.maximumNodes)/$($r.maximumElements).`r`n`r`nAllows repeated CAD edits, transfers, meshes, solver runs, results and Save/Reopen inside this scope. No additional stage prompts. Existing native resource limits remain enforced. You can revoke at any time. Experimental; not for engineering decisions."
    }
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object System.Drawing.Point(320, 220)
    $cancel.Size = New-Object System.Drawing.Size(95, 32)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $allow = New-Object System.Windows.Forms.Button
    $allow.Text = 'Allow'
    $allow.Location = New-Object System.Drawing.Point(425, 220)
    $allow.Size = New-Object System.Drawing.Size(95, 32)
    $allow.DialogResult = [System.Windows.Forms.DialogResult]::OK
    if ($request.purpose -eq 'simulation') { $cancel.Location = New-Object System.Drawing.Point(400, 370); $allow.Location = New-Object System.Drawing.Point(505, 370); $allow.Text = 'Authorize' }
    $form.Controls.AddRange(@($message, $cancel, $allow))
    # Enter defaults to Cancel. Escape, title-bar close, and timeout deny.
    $form.AcceptButton = $cancel
    $form.CancelButton = $cancel
    $form.ActiveControl = $cancel
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $timeoutMs
    $timer.Add_Tick({ $timer.Stop(); $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() })
    $form.Add_Shown({
        # Hidden process startup can hide the first form too. Show only this dialog.
        [void][TunaCADApprovalWindow]::ShowWindow($form.Handle, 5)
        $form.ActiveControl = $cancel; $form.Activate(); $timer.Start()
    })
    try { $result = $form.ShowDialog() }
    finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write("ALLOW`n"); exit 0 }
    exit 1
} catch { exit 1 }
