# Sandbox policy schema

Fields of the resolved runtime policy.

The resolved runtime policy sent to the gateway per cycle.

| Name | Description |
| --- | --- |
| `filesystem_policy.read_only` | Paths mounted read-only: /usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log. |
| `filesystem_policy.read_write` | Writable paths. Only /sandbox, /tmp and /dev/null; a floor rejects /, /usr, /lib, /etc, /app, /bin, /sbin, /boot, /var. |
| `network_policies` | Absent by default, which means no egress. Populated per run by allowEgress({ hosts, binaries }). |
| `landlock.compatibility` | best_effort — enforced where the kernel supports it. |
| `process.run_as_user` | sandbox. Re-asserted by enforceSandboxFloor() after any override. |

Overrides compose per project and per agent; `enforceSandboxFloor()` runs last and cannot be overridden. Narrative version: [sandbox hub](../hubs/sandbox.md).
