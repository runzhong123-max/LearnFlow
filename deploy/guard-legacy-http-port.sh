#!/bin/sh
# Close the old standalone API's public listener without stopping its process.
# Local clients remain unaffected. Install as an idempotent boot-time oneshot.
set -eu
for tool in iptables ip6tables; do
  command -v "$tool" >/dev/null 2>&1 || continue
  "$tool" -C INPUT ! -i lo -p tcp --dport 8000 -m comment --comment learnflow-legacy-api-guard -j REJECT 2>/dev/null ||
    "$tool" -I INPUT 1 ! -i lo -p tcp --dport 8000 -m comment --comment learnflow-legacy-api-guard -j REJECT
done
