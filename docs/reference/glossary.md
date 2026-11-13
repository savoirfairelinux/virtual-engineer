# Glossary

One term per concept.

One term per concept, used consistently across this documentation.

| Term | Definition |
| --- | --- |
| Task | One unit of work, of type code-gen or code-review, with a persisted state machine. |
| Cycle | One agent execution inside one task. A coding task may run several. |
| Sandbox | The ephemeral OpenShell environment a cycle runs in. Never called a container in this documentation. |
| Gateway | The OpenShell service that creates sandboxes through a compute driver and enforces policy. |
| Capability | A role a project needs filled: issue_tracking, source_control, code_review, agent_execution. |
| Binding | The row that assigns one integration to one capability of one project. |
| Integration | A configured external system or agent engine, with encrypted credentials. |
| Engine | The agent CLI that executes a cycle. Eight are supported. |
| Push target | A repository VE pushes to, ordered by commitOrder. |
| Transition | An appended state_transitions row. The audit trail is made of these. |
