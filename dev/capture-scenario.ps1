# Phase 6 fixture capture driver.
#
# Dev-only helper. It talks to the injected `dsh-turn-meter-fixture-recorder`
# control route on the running web host, launches one recorded scenario per
# call, and reports the session id that must be harvested afterwards.
#
#   powershell -File dev/capture-scenario.ps1 -Name A1
#
# Scenarios are listed in $Scenarios below; each entry carries the prompt, an
# optional interrupt delay, and the working directory the agent runs in.
#
# Phase 6 additions: `E1` (tool-only turn), `E2` (tool error), `E3` (provider
# retry). They are appended rather than renumbered so every fixture recorded in
# Phase 2 keeps the name its docs use.

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Base = 'http://127.0.0.1:50001/turn-meter-fixture',
  [switch]$Status,
  [string]$Recipe = ''
)

$ErrorActionPreference = 'Stop'

if ($Status) {
  (Invoke-WebRequest -Uri "$Base/status" -UseBasicParsing -TimeoutSec 30).Content
  exit 0
}

$projectDir = 'E:\Projects\DSHarness\dsh-turn-performance-meter'
$scratch = Join-Path $projectDir 'dev\scratch'

$Scenarios = @{
  # A — reasoning -> tool -> reasoning, three model calls, two sequential tools.
  A1 = @{
    cwd = $projectDir
    task = @'
Do exactly this and nothing else. Do not read or write files. Do not describe your plan.
1. Call the pwsh tool with exactly this command: Write-Output 'alpha-7'
2. Then call the pwsh tool with exactly this command: Write-Output 'beta-9'
3. Then reply with one short sentence that contains both outputs.
'@
  }
  # B — pwsh plus a write/edit tool pair with a substantial generated payload.
  B1 = @{
    cwd = $projectDir
    task = @'
Work only inside the directory dev/scratch. Do exactly this and nothing else.
1. Call the write tool to create dev/scratch/fixture-b1.txt with exactly these three lines:
   line-one-111
   line-two-222
   line-three-333
2. Then call the edit tool on dev/scratch/fixture-b1.txt to replace "line-two-222" with "line-two-222-edited".
3. Then call the pwsh tool with exactly this command: Get-Content dev/scratch/fixture-b1.txt
4. Then reply with one short sentence stating what the file contains.
'@
  }
  # C — manually interrupted mid-stream.
  C1 = @{
    cwd = $projectDir
    interruptAfterMs = 9000
    task = @'
Write a detailed technical explanation of how a streaming large language model
produces tokens, covering tokenization, the decode loop, sampling, and how a
client receives incremental deltas. Write at least 1200 words. Do not use any
tools. Do not stop early.
'@
  }
  # D — the DeepSeek official adapter, which is the route expected to report
  # provider reasoning tokens. D1 exercises reasoning plus a tool call; D2
  # exercises reasoning plus a text answer across two model calls.
  D1 = @{
    cwd = $projectDir
    provider = 'deepseek-official'
    model = 'deepseek-v4-pro'
    task = @'
Do exactly this and nothing else. Do not read or write files.
1. Call the pwsh tool with exactly this command: Write-Output 'gamma-3'
2. Then reply with one short sentence that contains the output.
'@
  }
  D2 = @{
    cwd = $projectDir
    provider = 'deepseek-official'
    model = 'deepseek-v4-pro'
    task = @'
Think step by step, then answer. Do not use any tools.
A turn-based performance meter measures model generation throughput. Explain in
five short numbered steps how it should split a turn's generation time between
reasoning output and ordinary output when the two phases can interleave.
'@
  }
  # ---- Phase 6 additions -------------------------------------------------
  # E1 — tool-only turn: the model emits a tool call and ends immediately after
  # the result, producing no surface text. The recorded run of this recipe had to
  # be requested twice: the first instruction still let the model spend five
  # tokens on a closing sentence, which is a *tool-then-text* turn rather than the
  # tool-only shape §25 describes. The wording below forbids any final message
  # explicitly.
  E1 = @{
    cwd = $projectDir
    task = @'
Call the pwsh tool with exactly this command: Write-Output 'tool-only-1'
Then end your turn. Your entire response must be the tool call and nothing else:
no reply text before it, no reply text after the tool result, no summary, no
confirmation. Do not produce any assistant message in this turn.
'@
  }
  # E2 — tool error: the pwsh call names a parameter that does not exist, so the
  # tool invocation itself fails and DSH records `tool/result.error`. A merely
  # failing *command* (a missing path) is not enough: DSH records that as a
  # successful call whose output happens to contain stderr, which is a different
  # shape and the first recorded attempt showed exactly that.
  E2 = @{
    cwd = $projectDir
    task = @'
Do exactly this and nothing else.
1. Call the pwsh tool with exactly this command: Get-ChildItem -NotARealParameterName
2. That parameter does not exist, so the tool invocation itself will fail.
3. Then reply with one short sentence confirming that the tool reported an error.
'@
  }
  # E3 — provider retry: the DeepSeek official route is asked for a reasoning
  # turn, which is the recorded route most likely to schedule an `llm/retry`
  # (the recorded D1/D2 runs show none). If no retry is observable the fixture is
  # still valid evidence of that; the test records which happened.
  E3 = @{
    cwd = $projectDir
    provider = 'deepseek-official'
    model = 'deepseek-v4-pro'
    task = @'
Think step by step. Do not use any tools. Then answer in one short sentence:
what is the sum of the first twenty positive integers?
'@
  }
}

$scenario = $Scenarios[$Name]
if ($null -eq $scenario) {
  Write-Error "unknown scenario '$Name'; known: $($Scenarios.Keys -join ', ')"
  exit 2
}

New-Item -ItemType Directory -Force -Path $scratch | Out-Null

$payload = @{
  task = $scenario.task.Trim()
  cwd  = $scenario.cwd
}
foreach ($key in @('interruptAfterMs', 'provider', 'model', 'agentPreset')) {
  if ($scenario.ContainsKey($key)) { $payload[$key] = $scenario[$key] }
}

$json = $payload | ConvertTo-Json -Depth 5 -Compress
$response = Invoke-RestMethod -Uri "$Base/scenario" -Method Post -Body $json -ContentType 'application/json' -TimeoutSec 120
if ($Recipe -ne '') {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Recipe) | Out-Null
  $response | ConvertTo-Json -Depth 5 | Set-Content -Path $Recipe -Encoding utf8
}
"scenario=$Name"
$response | ConvertTo-Json -Compress
