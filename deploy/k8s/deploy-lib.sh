#!/usr/bin/env bash

require_ghcr_digest_ref() {
  local image_ref="$1"
  [[ "$image_ref" =~ ^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]
}

valid_storage_class_name() {
  local storage_class="$1"
  [[ "$storage_class" =~ ^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$ && ${#storage_class} -le 253 ]]
}