#!/bin/bash
set -e

AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
ECR_REPO="606754308994.dkr.ecr.eu-north-1.amazonaws.com/cdk-hnb659fds-container-assets-606754308994-eu-north-1"
TAG="kimi-adapter-$(date +'%Y%m%d%H%M')"
IMAGE="${ECR_REPO}:${TAG}"
REGION="eu-north-1"
CLUSTER="paperclip"
SERVICE="Paperclip-PaperclipService1F756615-DmfaHKTvZPXJ"
TASK_FAMILY="paperclip-server"

echo "=== Step 1: ECR Login ==="
"$AWS" ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REPO"

echo "=== Step 2: Build Docker image ==="
cd "C:\Users\thame\Desktop\Project for Qyias Platfrom\vendor\paperclip"
docker build -f Dockerfile.kimi-patch -t "$IMAGE" .

echo "=== Step 3: Push to ECR ==="
docker push "$IMAGE"

echo "=== Step 4: Register new task definition ==="
currentTd=$("$AWS" ecs describe-task-definition --task-definition "$TASK_FAMILY" --region "$REGION")
# Use Python to update the image in the task definition JSON
newTd=$(echo "$currentTd" | /c/Python314/python -c "
import json, sys
data = json.load(sys.stdin)['taskDefinition']
# Remove fields not allowed in register-task-definition
for key in ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'placementConstraints', 'compatibilities', 'registeredAt', 'registeredBy']:
    data.pop(key, None)
data['containerDefinitions'][0]['image'] = '$IMAGE'
print(json.dumps(data))
")
newTdResult=$("$AWS" ecs register-task-definition --region "$REGION" --cli-input-json "$newTd")
newRevision=$(echo "$newTdResult" | /c/Python314/python -c "import json,sys; print(json.load(sys.stdin)['taskDefinition']['taskDefinitionArn'])")
echo "New task definition: $newRevision"

echo "=== Step 5: Update ECS service ==="
"$AWS" ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$newRevision" \
  --region "$REGION" \
  --force-new-deployment >/dev/null

echo "=== Step 6: Wait for deployment ==="
echo "Waiting for service to stabilize (this takes ~2 minutes)..."
"$AWS" ecs wait services-stable \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --region "$REGION"

echo "=== DEPLOYMENT COMPLETE ==="
echo "Image: $IMAGE"
echo "Task: $newRevision"
echo "Kimi adapter is now live at https://paperclip.atahdak.com"
