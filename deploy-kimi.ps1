$ErrorActionPreference = "Stop"
$ECR_REPO = "606754308994.dkr.ecr.eu-north-1.amazonaws.com/cdk-hnb659fds-container-assets-606754308994-eu-north-1"
$TAG = "kimi-adapter-$(Get-Date -Format 'yyyyMMddHHmm')"
$IMAGE = "${ECR_REPO}:${TAG}"
$REGION = "eu-north-1"
$CLUSTER = "paperclip"
$SERVICE = "Paperclip-PaperclipService1F756615-DmfaHKTvZPXJ"
$TASK_FAMILY = "paperclip-server"

Write-Host "=== Step 1: ECR Login ===" -ForegroundColor Cyan
$pass = aws ecr get-login-password --region $REGION
docker login --username AWS --password $pass $ECR_REPO
if ($LASTEXITCODE -ne 0) { throw "ECR login failed" }

Write-Host "`n=== Step 2: Build Docker image ===" -ForegroundColor Cyan
Set-Location "C:\Users\thame\Desktop\Project for Qyias Platfrom\vendor\paperclip"
docker build -f Dockerfile.kimi-patch -t $IMAGE .
if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }

Write-Host "`n=== Step 3: Push to ECR ===" -ForegroundColor Cyan
docker push $IMAGE
if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }

Write-Host "`n=== Step 4: Register new task definition ===" -ForegroundColor Cyan
$currentTd = aws ecs describe-task-definition --task-definition $TASK_FAMILY --region $REGION | ConvertFrom-Json
$td = $currentTd.taskDefinition
$td.containerDefinitions[0].image = $IMAGE

$newTd = @{
    family = $td.family
    taskRoleArn = $td.taskRoleArn
    executionRoleArn = $td.executionRoleArn
    networkMode = $td.networkMode
    containerDefinitions = $td.containerDefinitions
    volumes = $td.volumes
    requiresCompatibilities = $td.requiresCompatibilities
    cpu = $td.cpu
    memory = $td.memory
}

$tdJson = $newTd | ConvertTo-Json -Depth 20 -Compress
$newTdResult = aws ecs register-task-definition `
    --region $REGION `
    --cli-input-json $tdJson | ConvertFrom-Json

$newRevision = $newTdResult.taskDefinition.taskDefinitionArn
Write-Host "New task definition: $newRevision" -ForegroundColor Green

Write-Host "`n=== Step 5: Update ECS service ===" -ForegroundColor Cyan
aws ecs update-service `
    --cluster $CLUSTER `
    --service $SERVICE `
    --task-definition $newRevision `
    --region $REGION `
    --force-new-deployment | Out-Null

Write-Host "`n=== Step 6: Wait for deployment ===" -ForegroundColor Cyan
Write-Host "Waiting for service to stabilize (this takes ~2 minutes)..."
aws ecs wait services-stable `
    --cluster $CLUSTER `
    --services $SERVICE `
    --region $REGION

Write-Host "`n✅ DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "Image: $IMAGE"
Write-Host "Task: $newRevision"
Write-Host "Kimi adapter is now live at https://paperclip.atahdak.com"
