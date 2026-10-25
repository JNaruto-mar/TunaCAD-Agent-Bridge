$ErrorActionPreference = 'Stop'
$script:child = $null
$script:readTask = $null
$script:state = 'stopped'
$script:stopRequested = $false
$script:closeWhenStopped = $false
$script:ownsMutex = $false
try {
    $launch = [Console]::In.ReadLine() | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($launch.node) -or -not [IO.File]::Exists($launch.node) -or
        -not [IO.Path]::IsPathRooted($launch.host) -or -not [IO.File]::Exists($launch.host)) { throw 'Runtime unavailable.' }
    if (-not [Environment]::UserInteractive) { throw 'An interactive Windows session is required.' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TunaCADManagerWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command); }'
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $created = $false
    $script:mutex = New-Object System.Threading.Mutex($true, 'Local\TunaCADCompanionManager', [ref]$created)
    if (-not $created) {
        [Console]::Out.WriteLine('TUNACAD_MANAGER_READY')
        [void][System.Windows.Forms.MessageBox]::Show('The Companion manager is already open. Check your taskbar.', 'TunaCAD Companion')
        exit 0
    }
    $script:ownsMutex = $true

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'TunaCAD Companion Manager'
    $form.ClientSize = New-Object System.Drawing.Size(560, 290)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedSingle'
    $form.MaximizeBox = $false
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $heading = New-Object System.Windows.Forms.Label
    $heading.Text = 'TunaCAD Companion'
    $heading.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
    $heading.Location = New-Object System.Drawing.Point(24, 20)
    $heading.Size = New-Object System.Drawing.Size(510, 38)
    $status = New-Object System.Windows.Forms.Label
    $status.Location = New-Object System.Drawing.Point(24, 76)
    $status.Size = New-Object System.Drawing.Size(510, 66)
    $note = New-Object System.Windows.Forms.Label
    $note.Text = "PowerShell and Companion run behind this window.`r`nMinimize it while using AI in TunaCAD. Closing it stops the Companion started here. Device trust remains saved."
    $note.Location = New-Object System.Drawing.Point(24, 152)
    $note.Size = New-Object System.Drawing.Size(510, 66)
    $startButton = New-Object System.Windows.Forms.Button
    $startButton.Text = 'Start'
    $startButton.Location = New-Object System.Drawing.Point(24, 236)
    $startButton.Size = New-Object System.Drawing.Size(100, 34)
    $stopButton = New-Object System.Windows.Forms.Button
    $stopButton.Text = 'Stop'
    $stopButton.Location = New-Object System.Drawing.Point(136, 236)
    $stopButton.Size = New-Object System.Drawing.Size(100, 34)
    $openButton = New-Object System.Windows.Forms.Button
    $openButton.Text = 'Open TunaCAD'
    $openButton.Location = New-Object System.Drawing.Point(364, 236)
    $openButton.Size = New-Object System.Drawing.Size(170, 34)
    $form.Controls.AddRange(@($heading, $status, $note, $startButton, $stopButton, $openButton))

    function Set-ManagerState([string]$value) {
        $script:state = $value
        $startButton.Enabled = $value -in @('stopped', 'failed', 'port_busy', 'already_running')
        $stopButton.Enabled = $value -in @('starting', 'running')
        $startButton.Text = if ($value -eq 'already_running') { 'Check again' } else { 'Start' }
        $status.Text = switch ($value) {
            'starting' { 'Starting Companion and checking installed AI clients. This can take about a minute.' }
            'running' { "Running. Open TunaCAD and connect your AI agent.`r`nAny device trust request appears in a separate Allow / Cancel window." }
            'stopping' { 'Stopping Companion and closing its AI sessions. Please wait.' }
            'already_running' { 'Companion is already running outside this manager. You can use TunaCAD now. This window will not stop that other process.' }
            'port_busy' { 'Another process is using the Companion port. Close its owning application before trying Start again.' }
            'failed' { 'Companion could not start or stopped unexpectedly. Check that Node.js 20 or newer is installed, then try Start again.' }
            default { 'Not started by this window. Click Start to check or start Companion.' }
        }
    }

    function Request-CompanionStop {
        if ($null -eq $script:child -or $script:child.HasExited -or $script:stopRequested) { return }
        $script:stopRequested = $true
        Set-ManagerState 'stopping'
        # A private stdin command stops only the process created by this window.
        try { $script:child.StandardInput.WriteLine('stop'); $script:child.StandardInput.Flush(); $script:child.StandardInput.Close() }
        catch { $script:child.StandardInput.Close() }
    }

    $startButton.Add_Click({
        if ($null -ne $script:child) { return }
        $script:stopRequested = $false
        Set-ManagerState 'starting'
        try {
            $info = New-Object System.Diagnostics.ProcessStartInfo
            $info.FileName = [string]$launch.node
            # Windows filenames cannot contain a quote; no shell interprets these arguments.
            $info.Arguments = '"' + [string]$launch.host + '"'
            $info.WorkingDirectory = [IO.Path]::GetDirectoryName([string]$launch.host)
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
            $info.RedirectStandardInput = $true
            $info.RedirectStandardOutput = $true
            $script:child = New-Object System.Diagnostics.Process
            $script:child.StartInfo = $info
            if (-not $script:child.Start()) { throw 'Could not start Companion.' }
            $script:readTask = $script:child.StandardOutput.ReadLineAsync()
        } catch {
            if ($null -ne $script:child) { $script:child.Dispose() }
            $script:child = $null
            Set-ManagerState 'failed'
        }
    })
    $stopButton.Add_Click({ Request-CompanionStop })
    $openButton.Add_Click({
        try { [void][System.Diagnostics.Process]::Start('https://tunacad.com/workspace') }
        catch { [void][System.Windows.Forms.MessageBox]::Show('Open https://tunacad.com/workspace in your browser.', 'TunaCAD Companion') }
    })
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 150
    $timer.Add_Tick({
        if ($null -eq $script:child) { return }
        # Read asynchronously so startup, shutdown and the native trust dialog
        # never block the manager's Windows message loop.
        for ($i = 0; $i -lt 8 -and $null -ne $script:readTask -and $script:readTask.IsCompleted; $i++) {
            try {
                $line = $script:readTask.GetAwaiter().GetResult()
                if ($null -eq $line) { $script:readTask = $null; break }
                if ($line.Length -le 100) {
                    $message = $line | ConvertFrom-Json
                    if ($message.state -in @('starting', 'running', 'stopping', 'stopped', 'already_running', 'port_busy', 'failed')) {
                        if (-not $script:stopRequested -or $message.state -ne 'running') { Set-ManagerState $message.state }
                    }
                }
                $script:readTask = $script:child.StandardOutput.ReadLineAsync()
            } catch { $script:readTask = $null }
        }
        if ($script:child.HasExited -and $null -eq $script:readTask) {
            $exitCode = $script:child.ExitCode
            $script:child.Dispose()
            $script:child = $null
            if ($script:state -notin @('already_running', 'port_busy', 'failed')) {
                if ($exitCode -eq 0 -and $script:stopRequested) { Set-ManagerState 'stopped' }
                else { Set-ManagerState 'failed' }
            }
            if ($script:closeWhenStopped) { $form.Close() }
        }
    })
    $form.Add_FormClosing({
        param($sender, $event)
        if ($null -eq $script:child -or $script:child.HasExited) { return }
        $event.Cancel = $true
        if (-not $script:closeWhenStopped) {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                'Stop the Companion started by this window and close its AI sessions?',
                'Close TunaCAD Companion', [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
            $script:closeWhenStopped = $true
        }
        Request-CompanionStop
    })
    $form.Add_Shown({
        # Hidden PowerShell startup can hide its first form; show only the manager.
        [void][TunaCADManagerWindow]::ShowWindow($form.Handle, 5)
        $form.Activate()
        $timer.Start()
        [Console]::Out.WriteLine('TUNACAD_MANAGER_READY')
    })
    Set-ManagerState 'stopped'
    try { [void]$form.ShowDialog() }
    finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
} catch {
    [Console]::Out.WriteLine('TUNACAD_MANAGER_FAILED')
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show('Could not open the Companion manager. Check the Node.js and Windows PowerShell installations.', 'TunaCAD Companion')
    } catch { }
    exit 1
} finally {
    if ($null -ne $script:child) {
        # Closing the private pipe also requests graceful shutdown if the UI fails.
        try { $script:child.StandardInput.Close() } catch { }
        $script:child.Dispose()
    }
    if ($script:ownsMutex) { $script:mutex.ReleaseMutex() }
    if ($null -ne $script:mutex) { $script:mutex.Dispose() }
}
