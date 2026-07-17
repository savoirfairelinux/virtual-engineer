#!/usr/bin/env bash

require_ghcr_digest_ref() {
  local image_ref="$1"
  [[ "$image_ref" =~ ^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]
}