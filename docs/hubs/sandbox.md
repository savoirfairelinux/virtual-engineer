# Sandbox

Runtime policy, lifecycle, egress, and paths.

Isolation comes from OpenShell runtime policies, not from Docker flags. The sandbox spec carries only an image, env, command, an optional prompt, and an optional egress spec — there is no `networkMode`, `--read-only`, `--cap-drop`, or `--tmpfs`. VE never runs `docker run` for an agent; Docker appears only as the gateway's compute driver.

## Base policy

```
version: 1
filesystem_policy:
  read_only:  [/usr, /lib, /proc, /dev/urandom,
               /app, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null]
landlock:
  compatibility: best_effort
process:
  run_as_user: sandbox
  run_as_group: sandbox
```

No `network_policies` section means no egress: network is deny-by-default, and each run opens only what its adapter declares through `allowEgress({ hosts, binaries })`. Per-project and per-agent overrides compose on top, after which `enforceSandboxFloor()` re-asserts the sandbox user and rejects any `read_write` entry naming `/`, `/usr`, `/lib`, `/etc`, `/app`, `/bin`, `/sbin`, `/boot`, or `/var`.

## Lifecycle per cycle

1The host creates a scratch workspace and clones every push target, recording a credential-free remote per local path.

2A uniquely named sandbox is created with the resolved runtime policy; credential env vars are split into a temporary provider.

3Configured skill sources are installed host-side, then the whole workspace — including .git — is uploaded to /sandbox.

4An optional post-clone script runs inside the sandbox, then the agent worker is executed with the repository as its workdir.

5Coding runs download the repository back and rebuild .git from the trusted remotes. Review runs download nothing.

6The sandbox, the temporary credential provider, and the host directory are all destroyed.

## Paths inside the sandbox

| Name | Description |
| --- | --- |
| `/sandbox/` | The uploaded workspace, and the agent working directory. |
| `/tmp/user-prompt.txt` | The per-cycle generated user prompt. |
| `/app/agent-worker/` | The worker runtime, read-only. |
| `/tmp/ve-agent-submission.json` | The MCP submission artifact. |

Policy denials are harvested best-effort after every attempt from the sandbox logs, scrubbed, and deduplicated per sandbox. Related: [Trust boundaries](../concepts/trust.md), [policy schema](../reference/ref-policy.md), [security hub](security.md).
