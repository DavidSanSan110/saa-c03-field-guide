#!/bin/bash
set -euo pipefail

TOKEN="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
ID="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
AZ="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)"

mkdir -p /srv/fg-lab04
printf 'instance=%s az=%s\n' "$ID" "$AZ" > /srv/fg-lab04/index.html

systemd-run --unit fg-lab04-web python3 -m http.server 80 --directory /srv/fg-lab04
