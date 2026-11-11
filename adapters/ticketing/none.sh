#!/usr/bin/env bash
# No ticket tracker configured: every command says so and exits 2.
echo "no ticketing adapter configured (adapters.ticketing.kind: none)" >&2
exit 2
