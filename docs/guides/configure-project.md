# Configure a project

Repository, branch, bindings, agent.

A project is the object that ties a repository, a branch, a set of integrations, and an agent together.

- Set the repository and the base branch VE should work from.
- Bind one integration per capability the project needs. A coding project needs `issue_tracking`; a review project does not.
- Scope `issue_tracking` to a ticket project key, and `code_review` to the repositories it may act on.
- Bind an agent, then enable the project. Nothing is polled until it is enabled.

Concurrency is per agent, not global: each agent carries its own limit for how many cycles may run at once.
