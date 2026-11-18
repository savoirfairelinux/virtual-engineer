# Access control

Accounts, roles, policies, and the audit log.

Every Admin UI and API request is authenticated, then authorized by permission. A role sets the outer boundary; policies grant everything inside it.

## Accounts and sessions

- The first visit creates the first `admin` account. Setup is locked once any user exists.
- Sign-in returns an opaque session token; only its SHA-256 hash is stored. A session expires after 12 hours without activity.
- Five failed sign-ins within 15 minutes lock out the client address and the username, with a backoff that doubles from 30 seconds up to 15 minutes.
- Passwords need at least 8 characters and are checked against a common-password denylist.
- Accounts can sign in through an LDAP source instead of a local password. At least one enabled admin always keeps a local password, so a directory outage cannot lock every administrator out.

## Roles

| Role | Boundary |
| --- | --- |
| `admin` | Superuser. Passes every permission check. |
| `operator` | Grants nothing by itself; a new operator starts with the built-in Operator policy. |
| `viewer` | Read-only ceiling that no policy can exceed. |

## Permissions and policies

Permissions are named `<resource>.<action>`, such as `project.write` or `task.operate`. A policy is a named set of permissions, each global or scoped to one resource, bound to users or groups. A user's effective permissions are the union of the policies bound to them and to their groups.

Projects, integrations, agents, prompts, and OAuth apps belong to the user who created them and are private by default. Tasks inherit the owner of their project. Creation is a separate permission, such as `project.create`, so the right to create never reveals existing resources. An agent or project cannot reference another user's private prompts, agents, or integrations.

Five built-in policies cannot be edited or deleted:

| Policy | Grants |
| --- | --- |
| Operator | Create resources and use operational capabilities. No access to other owners' resources, no settings writes. |
| Viewer | Read-only status. |
| Registered Users | Every signed-in user reads ownerless built-in resources. |
| Resource Owner | Creators manage what they created. |
| Project Owners | Holders of `project.owner` manage that project and its tasks. |

A project owner delegates project and task permissions to a group from the project's **Access** action, without holding `policy.manage`.

These policies are unrelated to sandbox runtime policies, which govern what an agent may do — see [Sandbox](sandbox.md).

## Audit log

Every successful change through the Admin API appends a row to an append-only log: the actor, the action, the target, and the details with secret values masked. Sign-ins and failed sign-ins are recorded too. Read it under Configuration → Audit with the `audit.read` permission.

Task state changes are recorded separately as transitions — see [Observability](observability.md).
