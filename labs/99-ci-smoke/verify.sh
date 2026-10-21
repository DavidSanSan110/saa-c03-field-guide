#!/usr/bin/env bash
# Read-only check that infra.yml runs after an apply, from this directory, after `terraform init`.
# It makes no call that changes anything: it reads one output from the state.
set -euo pipefail

# The expected message is the default of variable "message" in variables.tf.
expected="$(sed -n '/^[[:space:]]*default[[:space:]]*=/{s/^[^"]*"//;s/"[^"]*$//;p;q;}' variables.tf)"
if [ -z "$expected" ]; then
  echo "verify: no default found in variables.tf" >&2
  exit 1
fi

actual="$(terraform output -raw message)"
if [ -z "$actual" ] || [ "$actual" != "$expected" ]; then
  echo "verify: output message is '$actual', expected '$expected'" >&2
  exit 1
fi

echo "verify: ok"
