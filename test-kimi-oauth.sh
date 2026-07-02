#!/bin/sh
set -e
home=/tmp/testhome
rm -rf "$home"
mkdir -p "$home/.kimi/credentials"
cp /host/credentials/kimi-code.json "$home/.kimi/credentials/"
cat > "$home/.kimi/config.toml" <<'EOF'
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
EOF
HOME="$home" timeout 60 kimi --verbose --debug --work-dir /tmp --print --output-format stream-json --yolo --prompt "hello" > /tmp/out.log 2>&1 || true
cat /tmp/out.log
