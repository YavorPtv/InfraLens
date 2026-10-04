param([string]$Profile = 'infralens-test-admin')

# Optional read-only AWS validation. Normal npm tests never invoke this script.
$ErrorActionPreference = 'Stop'
$account = aws sts get-caller-identity --profile $Profile --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $account -ne '230944684535') {
    throw 'Expected test account 230944684535. Policy verification stopped.'
}

$policyDocuments = @{}
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'test-*.policy.json') {
    $policyJson = Get-Content -Raw -LiteralPath $file.FullName
    $name = $file.Name.Substring(5).Replace('.policy.json', '')
    $policyDocuments[$name] = $policyJson
    $validationJson = aws accessanalyzer validate-policy --policy-document "file://$($file.FullName)" --policy-type IDENTITY_POLICY --profile $Profile --region eu-central-1 --output json --no-cli-pager
    if ($LASTEXITCODE -ne 0) { throw "AWS validation failed for $($file.Name)" }
    $validation = $validationJson | ConvertFrom-Json
    if (@($validation.findings).Count -gt 0) {
        $validation.findings | ConvertTo-Json -Depth 20 | Write-Output
        throw "Review AWS policy findings for $($file.Name). Nothing has been applied."
    }
    Write-Output "Validated: $($file.Name)"
}

$cases = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'test-policy-simulations.json') | ConvertFrom-Json
$passedCases = 0
$skippedCases = 0
$requestPath = [System.IO.Path]::GetTempFileName()
try {
    foreach ($case in $cases) {
        if ($case.SimulatorLimitation) {
            Write-Warning "NOT VERIFIED: $($case.Name). $($case.SimulatorLimitation)"
            $skippedCases++
            continue
        }
        $inputPolicies = @()
        foreach ($name in $case.Policies) {
            if (-not $policyDocuments.ContainsKey($name)) { throw "Unknown policy: $name" }
            $inputPolicies += $policyDocuments[$name]
        }
        $request = @{
            PolicyInputList = $inputPolicies
            ActionNames = @($case.Action)
            ResourceArns = @($case.Resource)
        }
        $contextEntries = @()
        foreach ($property in $case.Context.PSObject.Properties) {
            $contextType = 'string'
            if ($property.Value -is [array]) { $contextType = 'stringList' }
            $contextEntries += @{
                ContextKeyName = $property.Name
                ContextKeyValues = @($property.Value)
                ContextKeyType = $contextType
            }
        }
        if ($contextEntries.Count -gt 0) { $request.ContextEntries = $contextEntries }
        $requestJson = $request | ConvertTo-Json -Depth 30
        [System.IO.File]::WriteAllText($requestPath, $requestJson, [System.Text.UTF8Encoding]::new($false))
        $simulationJson = aws iam simulate-custom-policy --cli-input-json "file://$requestPath" --profile $Profile --region eu-central-1 --output json --no-cli-pager
        if ($LASTEXITCODE -ne 0) { throw "IAM simulation failed: $($case.Name)" }
        $simulation = $simulationJson | ConvertFrom-Json
        $results = @($simulation.EvaluationResults)
        if ($results.Count -ne 1 -or $results[0].EvalDecision -ne $case.ExpectedDecision) {
            $simulation | ConvertTo-Json -Depth 30 | Write-Output
            throw "Unexpected IAM decision: $($case.Name); expected $($case.ExpectedDecision)"
        }
        Write-Output "Passed: $($case.Name)"
        $passedCases++
    }
} finally {
    Remove-Item -LiteralPath $requestPath -ErrorAction SilentlyContinue
}
Write-Output "$($policyDocuments.Count) policies validated; $passedCases IAM simulations passed; $skippedCases cases not verified because of documented simulator limitations. No AWS changes made."
