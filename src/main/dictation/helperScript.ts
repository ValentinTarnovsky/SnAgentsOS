/**
 * The dictation helper (app 2.4.0): a static Windows PowerShell 5.1 script
 * that main spawns with -EncodedCommand (DictationService). It carries no
 * user data: the language and the engine come in the env vars
 * SNAOS_DICT_LANG / SNAOS_DICT_ENGINE, already validated by main and checked
 * again here, never interpolated into the text.
 *
 * Protocol: one JSON object per stdout line, UTF-8 without BOM.
 *   {t:"ready", engine:"online"|"offline", lang, fallback?}  the engine is listening
 *   {t:"hyp", text}    the phrase so far
 *   {t:"final", text}  a finished phrase
 *   {t:"error", code}  a DICTATION_ERRORS code (followed by end when fatal)
 *   {t:"end"}          always last
 * Stdin: "stop" ends the session keeping the last phrase; EOF (main gone) exits.
 *
 * Spike on Windows 11 / PS 5.1.26100 (2.4.0): Register-ObjectEvent refuses
 * WinRT events ("no se puede suscribir a eventos de Windows RT"), so the
 * online engine is a small C# bridge compiled at start with CodeDom (Add-Type
 * cannot load .winmd references) that raises a plain .NET event instead.
 * Without the unified Windows.winmd, AsTask is not reachable, so the bridge
 * polls IAsyncInfo. StartAsync with "Online speech recognition" off fails
 * with 0x80045509 (privacy): with engine "auto" the helper falls back to SAPI
 * (System.Speech, DictationGrammar on the default microphone) and reports it
 * in ready.fallback. CodeDom writes its temporary files under %TEMP%.
 *
 * Loop: Wait-Event has no timeout under a second (-Timeout is Int32 seconds),
 * so a 250 ms System.Timers.Timer event wakes it to look at stdin, which is
 * read with the raw stream ReadAsync: [Console]::In.ReadLineAsync is
 * synchronous on .NET Framework and would block every speech event.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$snOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$snOut.AutoFlush = $true
function Emit($o) { $snOut.WriteLine((ConvertTo-Json -InputObject $o -Compress)) }
$snLang = [string]$env:SNAOS_DICT_LANG
if ($snLang -cnotmatch '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$') { $snLang = '' }
$snEngine = [string]$env:SNAOS_DICT_ENGINE
if ($snEngine -cne 'online' -and $snEngine -cne 'offline') { $snEngine = 'auto' }
$snBridgeSrc = @'
using System;
using System.Threading;
using Windows.Foundation;
using Windows.Media.SpeechRecognition;
public sealed class SnaosDictMsg : EventArgs {
  public readonly string Kind; public readonly string Text;
  public SnaosDictMsg(string kind, string text) { Kind = kind; Text = text; }
}
public sealed class SnaosDictOnline {
  public event EventHandler<SnaosDictMsg> Message;
  public string Lang;
  private SpeechRecognizer rec;
  private static void Wait(IAsyncInfo op, int ms) {
    int waited = 0;
    while (op.Status == AsyncStatus.Started) { if (waited >= ms) throw new TimeoutException(); Thread.Sleep(15); waited += 15; }
    if (op.Status == AsyncStatus.Error) throw op.ErrorCode;
    if (op.Status != AsyncStatus.Completed) throw new OperationCanceledException();
  }
  private void Emit(string kind, string text) { EventHandler<SnaosDictMsg> h = Message; if (h != null) h(this, new SnaosDictMsg(kind, text)); }
  private static string Code(Exception ex) {
    if (ex is TimeoutException) return "start";
    uint hr = unchecked((uint)ex.HResult);
    if (hr == 0x80045509) return "privacy";
    if (hr == 0x80070005) return "mic_denied";
    return "start";
  }
  public string Open(string tag) {
    try {
      Windows.Globalization.Language lang = null;
      string prefix = tag.Length >= 2 ? tag.Split('-')[0] : "";
      foreach (Windows.Globalization.Language l in SpeechRecognizer.SupportedTopicLanguages) {
        if (string.Equals(l.LanguageTag, tag, StringComparison.OrdinalIgnoreCase)) { lang = l; break; }
      }
      if (lang == null && prefix.Length > 0) {
        foreach (Windows.Globalization.Language l in SpeechRecognizer.SupportedTopicLanguages) {
          if (l.LanguageTag.Split('-')[0].Equals(prefix, StringComparison.OrdinalIgnoreCase)) { lang = l; break; }
        }
      }
      if (lang == null) lang = SpeechRecognizer.SystemSpeechLanguage;
      Lang = lang.LanguageTag;
      rec = new SpeechRecognizer(lang);
      rec.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "dictation"));
      IAsyncOperation<SpeechRecognitionCompilationResult> op = rec.CompileConstraintsAsync();
      Wait(op, 15000);
      if (op.GetResults().Status != SpeechRecognitionResultStatus.Success) return "compile";
      rec.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromMinutes(2);
      rec.HypothesisGenerated += (s, e) => Emit("hyp", e.Hypothesis.Text);
      rec.ContinuousRecognitionSession.ResultGenerated += (s, e) => {
        if (e.Result.Status == SpeechRecognitionResultStatus.Success && e.Result.Confidence != SpeechRecognitionConfidence.Rejected) Emit("final", e.Result.Text);
      };
      rec.ContinuousRecognitionSession.Completed += (s, e) => Emit("done", e.Status.ToString());
      return null;
    } catch (Exception) { return "compile"; }
  }
  public string Start() {
    try { Wait(rec.ContinuousRecognitionSession.StartAsync(), 15000); return null; }
    catch (Exception ex) { return Code(ex); }
  }
  public void Stop() {
    try { Wait(rec.ContinuousRecognitionSession.StopAsync(), 3000); } catch (Exception) { }
  }
}
'@
$snSource = $null
$snReady = $null
$snBridge = $null
$snSapi = $null
$snFallback = $null
function Fail($code) { Emit ([ordered]@{ t = 'error'; code = $code }); Emit ([ordered]@{ t = 'end' }); exit 0 }
function Open-Online {
  $fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $md = Join-Path $env:SystemRoot 'System32\WinMetadata'
  $p = New-Object System.CodeDom.Compiler.CompilerParameters
  $p.GenerateInMemory = $true
  foreach ($r in @((Join-Path $fw 'System.Runtime.dll'), (Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll'), (Join-Path $md 'Windows.Foundation.winmd'), (Join-Path $md 'Windows.Media.winmd'), (Join-Path $md 'Windows.Globalization.winmd'), 'System.dll')) { [void]$p.ReferencedAssemblies.Add($r) }
  try {
    $cr = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($p, $snBridgeSrc)
    if ($cr.Errors.HasErrors) { return 'compile' }
    $b = $cr.CompiledAssembly.CreateInstance('SnaosDictOnline')
  } catch { return 'compile' }
  $code = $b.Open($snLang)
  if ($code) { return $code }
  Register-ObjectEvent -InputObject $b -EventName Message -SourceIdentifier 'snaos.online' | Out-Null
  $code = $b.Start()
  if ($code) { Unregister-Event -SourceIdentifier 'snaos.online'; return $code }
  $script:snBridge = $b
  $script:snSource = 'snaos.online'
  $script:snReady = [ordered]@{ t = 'ready'; engine = 'online'; lang = $b.Lang }
  return $null
}
function Open-Offline {
  try { Add-Type -AssemblyName System.Speech } catch { return 'no_recognizer' }
  $all = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($all.Count -eq 0) { return 'no_recognizer' }
  $info = $null
  $prefix = ($snLang -split '-')[0]
  foreach ($r in $all) { if ($r.Culture.Name -eq $snLang) { $info = $r; break } }
  if (-not $info -and $prefix) { foreach ($r in $all) { if ($r.Culture.TwoLetterISOLanguageName -eq $prefix) { $info = $r; break } } }
  if (-not $info) { $info = $all[0] }
  try {
    $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  } catch { return 'no_recognizer' }
  try { $e.SetInputToDefaultAudioDevice() } catch { $e.Dispose(); return 'no_mic' }
  Register-ObjectEvent -InputObject $e -EventName SpeechHypothesized -SourceIdentifier 'snaos.hyp' | Out-Null
  Register-ObjectEvent -InputObject $e -EventName SpeechRecognized -SourceIdentifier 'snaos.final' | Out-Null
  Register-ObjectEvent -InputObject $e -EventName RecognizeCompleted -SourceIdentifier 'snaos.done' | Out-Null
  try { $e.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple) } catch { return 'no_mic' }
  $script:snSapi = $e
  $script:snReady = [ordered]@{ t = 'ready'; engine = 'offline'; lang = $info.Culture.Name }
  return $null
}
# One event of the queue: true when the session is over.
function Handle($ev) {
  $id = $ev.SourceIdentifier
  if ($id -eq 'snaos.online') {
    $m = $ev.SourceEventArgs
    if ($m.Kind -eq 'hyp') { Emit ([ordered]@{ t = 'hyp'; text = [string]$m.Text }) }
    elseif ($m.Kind -eq 'final') { Emit ([ordered]@{ t = 'final'; text = [string]$m.Text }) }
    elseif ($m.Kind -eq 'done') {
      if ($m.Text -eq 'NetworkFailure') { Emit ([ordered]@{ t = 'error'; code = 'network' }) }
      elseif ($m.Text -eq 'MicrophoneUnavailable') { Emit ([ordered]@{ t = 'error'; code = 'no_mic' }) }
      elseif ($m.Text -eq 'AudioQualityFailure') { Emit ([ordered]@{ t = 'error'; code = 'audio' }) }
      return $true
    }
  } elseif ($id -eq 'snaos.hyp') {
    Emit ([ordered]@{ t = 'hyp'; text = [string]$ev.SourceEventArgs.Result.Text })
  } elseif ($id -eq 'snaos.final') {
    $r = $ev.SourceEventArgs.Result
    if ($r.Confidence -ge 0.3) { Emit ([ordered]@{ t = 'final'; text = [string]$r.Text }) }
  } elseif ($id -eq 'snaos.done') {
    if ($ev.SourceEventArgs.Error) { Emit ([ordered]@{ t = 'error'; code = 'audio' }) }
    return $true
  }
  return $false
}
function Drain {
  foreach ($ev in @(Get-Event)) { [void](Handle $ev); Remove-Event -EventIdentifier $ev.EventIdentifier }
}
try {
  if ($snEngine -ne 'offline') {
    $code = Open-Online
    if ($code) {
      if ($snEngine -eq 'online') { Fail $code }
      $snFallback = $code
    }
  }
  if (-not $snReady) {
    $code = Open-Offline
    if ($code) { Fail $code }
    if ($snFallback) { $snReady['fallback'] = $snFallback }
  }
  Emit $snReady
  # Wait-Event -Timeout takes whole seconds: a 250 ms timer event wakes the loop to look at stdin.
  $tick = New-Object System.Timers.Timer
  $tick.Interval = 250
  $tick.AutoReset = $true
  Register-ObjectEvent -InputObject $tick -EventName Elapsed -SourceIdentifier 'snaos.tick' | Out-Null
  $tick.Start()
  # Console.In.ReadLineAsync blocks on .NET Framework; the raw stream's ReadAsync does not.
  $stdin = [Console]::OpenStandardInput()
  $buf = New-Object byte[] 64
  $read = $stdin.ReadAsync($buf, 0, $buf.Length)
  $got = ''
  $over = $false
  while (-not $over) {
    $ev = Wait-Event
    if ($ev) {
      if ($ev.SourceIdentifier -ne 'snaos.tick') { $over = Handle $ev }
      Remove-Event -EventIdentifier $ev.EventIdentifier
    }
    if (-not $over -and $read.IsCompleted) {
      $n = 0
      if (-not $read.IsFaulted) { $n = $read.Result }
      if ($n -le 0) { break }
      $got += [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
      if ($got.Contains('stop')) {
        $tick.Stop()
        if ($snBridge) { $snBridge.Stop(); Start-Sleep -Milliseconds 150 }
        if ($snSapi) { $snSapi.RecognizeAsyncStop(); Start-Sleep -Milliseconds 300 }
        Drain
        $over = $true
      } elseif ($got.Length -gt 64) { $got = '' }
      if (-not $over) { $read = $stdin.ReadAsync($buf, 0, $buf.Length) }
    }
  }
  Emit ([ordered]@{ t = 'end' })
} catch {
  Emit ([ordered]@{ t = 'error'; code = 'internal' })
  Emit ([ordered]@{ t = 'end' })
}
exit 0
`

/** The script as sent: indentation, blank lines and comments dropped (the command line limit is 32767). */
export function dictationScript(): string {
  return SCRIPT.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join('\n')
}

let encoded: string | null = null

/** powershell.exe arguments: no profile, no prompts, the script as base64 UTF-16LE. */
export function buildDictationArgs(): string[] {
  if (!encoded) encoded = Buffer.from(dictationScript(), 'utf16le').toString('base64')
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}
