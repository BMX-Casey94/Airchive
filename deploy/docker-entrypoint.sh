#!/bin/sh
# Resolves file-backed secrets before handing control to the service.
#
# For every variable named FOO_FILE, the contents of the referenced file are
# exported as FOO and FOO_FILE is unset. This is what lets Docker secrets,
# systemd credentials and Kubernetes projected volumes supply the wallet seed,
# funding WIF, API keys and database password without any of them appearing in
# a plaintext .env, in `docker inspect`, or in the process environment of a
# child that only needs the value indirectly.
#
# Docker mounts secrets as root:root mode 0400. This script therefore starts as
# root, loads the files, then drops to the `node` user before exec'ing the
# service. A missing or unreadable file is fatal: starting with a silently
# absent seed would derive the wrong wallets and write to addresses nobody
# controls.
set -eu

for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)_FILE=.*/\1/p'); do
  file_var="${name}_FILE"
  eval "secret_path=\${${file_var}}"

  if [ ! -f "$secret_path" ] || [ ! -r "$secret_path" ]; then
    echo "entrypoint: ${file_var}=${secret_path} is missing or unreadable" >&2
    exit 1
  fi

  # Command substitution strips trailing newlines, which is what an editor or
  # `echo` will have left on the end of the secret file.
  secret_value=$(cat "$secret_path")
  if [ -z "$secret_value" ]; then
    echo "entrypoint: ${file_var}=${secret_path} is empty" >&2
    exit 1
  fi

  export "${name}=${secret_value}"
  unset "$file_var"
done

unset secret_path secret_value file_var name 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  exec su-exec node:node "$@"
fi

exec "$@"
